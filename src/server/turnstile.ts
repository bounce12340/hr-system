/**
 * Cloudflare Turnstile 人機驗證。
 *
 * 目的：擋掉對登入端點的自動化猜密碼。系統的密碼雜湊是 PBKDF2 10 萬輪，單次
 * 驗證成本高，未設防的 /api/auth/login 既能被暴力破解，也能被拿來當 CPU 消耗
 * 的攻擊面。
 *
 * ---------------------------------------------------------------------------
 * 為什麼驗證寫在後端，而不是「前端驗過再送出」
 * ---------------------------------------------------------------------------
 * 常見的 Turnstile 範例是在瀏覽器端把表單送出擋下來、驗過才呼叫真正的 API。
 * 那對暴力破解**完全無效**——機器人不會執行你的前端 JS，直接 POST
 * /api/auth/login 就繞過去了。唯一有效的位置是登入端點本身，也就是這裡。
 *
 * 憑證來源：`TURNSTILE_SITE_KEY`（公開）與 `TURNSTILE_SECRET_KEY`（機密）兩個
 * 環境變數。site key 本來就會出現在 HTML 中，不是秘密；secret key 只存在於
 * Worker 環境，正式環境用 `wrangler pages secret put`，本機開發放 `.dev.vars`
 * （已列入 .gitignore）。程式碼中不得出現任何金鑰字面值。
 *
 * ---------------------------------------------------------------------------
 * 兩個刻意的設計
 * ---------------------------------------------------------------------------
 * 1. **未設定時整個略過**（與 mailer.ts 同樣的取捨）。本機開發與自動化測試沒有
 *    金鑰是常態，若未設定就一律擋下，等於所有測試與本機登入全部失效。
 *
 * 2. **設定後驗證失敗一律擋下（fail closed）**，包含 siteverify 連不上的情況。
 *    這點和 mailer.ts 相反，而且是刻意的：寄信失敗只是通知沒送到，驗證失敗卻
 *    是防護失效。若在連線失敗時放行，任何能讓 Worker 連不到 siteverify 的人
 *    就等於關掉了整套防護。
 *
 *    代價是 siteverify 若真的中斷，所有人（含管理者）都登不進來。這是可接受的，
 *    因為 siteverify 與本 Worker 都在 Cloudflare 邊緣網路上；真的遇到，緊急
 *    處置是移除 TURNSTILE_SECRET_KEY 這個 secret，系統會退回未啟用狀態：
 *
 *        wrangler pages secret delete TURNSTILE_SECRET_KEY --project-name hr-system
 *
 *    為此連線失敗回 503（服務暫時不可用）而非 403（你沒通過驗證），讓維運者從
 *    狀態碼就能分辨是哪一種。
 */

import { ApiError } from "./http";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** 逾時上限。驗證卡住不該把整個登入請求拖到 Worker 逾時。 */
const VERIFY_TIMEOUT_MS = 10_000;

/**
 * 前端 widget 的 data-action，會原樣回到 siteverify 的回應裡。
 * 兩邊必須一致，改這裡就要一起改 src/client/turnstile.tsx。
 */
export const TURNSTILE_ACTION = "turnstile-spin-v1";

interface TurnstileEnv {
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
}

interface SiteverifyResponse {
  success?: boolean;
  action?: string;
  "error-codes"?: string[];
}

/**
 * 取得要交給前端的 site key；未啟用時回 null。
 *
 * **兩把金鑰必須成對才算啟用**，缺一即視為未啟用。這是為了讓設定錯誤的失敗模式
 * 可預測：
 * - 只設 secret：前端拿不到 site key、產不出 token，而後端卻要求 token
 *   → 所有人都登不進來，包含管理者。
 * - 只設 site key：畫面上有驗證框，後端卻不驗 → 假防護，比沒有更糟。
 *
 * 兩種都比「暫時沒有 Turnstile」嚴重，所以寧可退回未啟用。半套設定不會沒有聲音：
 * 管理者的「系統設定」頁會顯示目前是否已啟用（見 settings.ts）。
 */
export function turnstileSiteKey(env: unknown): string | null {
  const config = env as TurnstileEnv;
  if (!config?.TURNSTILE_SITE_KEY || !config?.TURNSTILE_SECRET_KEY) return null;
  return config.TURNSTILE_SITE_KEY;
}

export function isTurnstileEnabled(env: unknown): boolean {
  return turnstileSiteKey(env) !== null;
}

/**
 * 驗證這次請求來自真人；未通過就拋 ApiError 中斷呼叫端。
 *
 * 呼叫端必須在**任何昂貴或有副作用的動作之前**呼叫（登入是在密碼雜湊之前，
 * 忘記密碼是在查帳號與寄信之前），否則擋不到想擋的成本。
 */
export async function assertHuman(request: Request, env: unknown, token: unknown): Promise<void> {
  const config = env as TurnstileEnv;
  const secret = config?.TURNSTILE_SECRET_KEY;
  if (!secret || !isTurnstileEnabled(env)) return;

  if (typeof token !== "string" || token.trim() === "") {
    throw new ApiError(403, "請先完成人機驗證。");
  }

  const form = new URLSearchParams({ secret, response: token });
  // remoteip 是選填；沒有值時不要送空字串，那會被當成無效的 IP。
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp) form.set("remoteip", clientIp);

  let payload: SiteverifyResponse;
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      body: form,
    });
    if (!response.ok) throw new Error(`siteverify ${response.status}`);
    payload = await response.json() as SiteverifyResponse;
  } catch {
    // 見檔頭說明：這裡刻意不放行。503 用來與「驗證未通過」的 403 區分。
    throw new ApiError(503, "人機驗證服務暫時無法連線，請稍後再試。");
  }

  if (payload?.success !== true) {
    // 不轉述 error-codes：那是給維運看的，對使用者只是雜訊，
    // 而 timeout-or-duplicate 這類碼還會告訴攻擊者 token 是不是被用過了。
    throw new ApiError(403, "人機驗證未通過，請重新驗證後再試。");
  }

  // action 比對屬於縱深防禦，主要防線是 token 一次性、五分鐘內有效、且只能
  // 由 widget 註冊的網域產生。刻意只在回應帶有 action 時比對：Cloudflare 的
  // 測試用 secret key 回的是合成回應，不含 action，若嚴格要求會讓本機與自動化
  // 測試永遠失敗——而放寬並不會給攻擊者任何空間，因為回應由 Cloudflare 簽發，
  // 攻擊者無法讓它「剛好缺少」這個欄位。
  if (payload.action !== undefined && payload.action !== TURNSTILE_ACTION) {
    throw new ApiError(403, "人機驗證未通過，請重新驗證後再試。");
  }
}
