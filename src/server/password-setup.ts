import { assertPasswordStrength, hashPassword } from "./auth";
import { ApiError, json, parseJson, requiredString, uuid } from "./http";
import { sendMail } from "./mailer";

/**
 * 一次性密碼設定連結（migrations/0012_password_setup_tokens.sql）。
 *
 * 取代舊的「建立帳號回傳明碼臨時密碼」流程，並同時提供忘記密碼的自助救援。
 * 系統從此不再有任何路徑會產生「需要人工轉達的明碼密碼」——密碼只由本人在
 * 設定頁輸入一次，中間不經過 admin、也不會留在信箱裡。
 *
 * 六個安全決策，改動前請先讀完：
 *
 * 1. **token 只存雜湊**。資料庫存 SHA-256(token)，原文只出現在寄出的信／
 *    回應的 setupUrl 裡。資料庫外洩時攻擊者拿不到可用的連結。
 *    連帶規定：token 原文不得進入任何 log 或錯誤訊息（本檔沒有一處 console.*，
 *    ApiError 訊息也只描述狀態不回述 token）。
 *
 * 2. **單次使用**。設定成功後 used_at 填上時間；重複使用一律 410。
 *    刻意保留已使用的列而非刪除，才能把「用過了」與「不存在」區分開來。
 *
 * 3. **有效期限**由設定值 password_setup_token_hours（1～72，預設 24）決定，
 *    發放當下換算成絕對時間存進 expires_at。
 *
 * 4. **設定成功即刪除該帳號所有 sessions**。若帳號曾被他人登入（正是使用者
 *    來重設密碼的常見原因），只換密碼而不踢掉既有登入狀態，等於重設了個寂寞。
 *
 * 5. **連結網域取自設定值 app_base_url，絕不從 request 的 Host header 推導**。
 *    Host header 可偽造；用它組連結會讓攻擊者能誘使系統寄出指向自己網域的
 *    「官方」密碼設定信（host header injection）。未設定時一律不寄信，
 *    改回傳相對路徑的 setupUrl 讓 admin 自行轉達。
 *
 * 6. **forgot-password 不得洩漏帳號是否存在**。不論 email 存在與否、帳號
 *    是否停用或已封存，一律回 200 且訊息完全相同（見 FORGOT_PASSWORD_MESSAGE）。
 */

// ---------------------------------------------------------------------------
// token 原語
// ---------------------------------------------------------------------------

/** 32 bytes = 256 bits 熵，遠超過任何暴力猜測的可行範圍。 */
const TOKEN_BYTES = 32;

const SETTING_HOURS = "password_setup_token_hours";
const SETTING_BASE_URL = "app_base_url";
const DEFAULT_TOKEN_HOURS = 24;
const MIN_TOKEN_HOURS = 1;
const MAX_TOKEN_HOURS = 72;

export type SetupPurpose = "account_setup" | "password_reset";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 一律用 crypto.getRandomValues。Math.random 非密碼學安全（同一 isolate 內
 * 觀察幾個輸出即可推得後續），時間戳與遞增序號更是直接可預測——任何一種都會讓
 * 攻擊者能猜出別人的設定連結，等於繞過整套驗證。
 *
 * 編碼用 base64url：token 會直接放進網址（?setup=...），必須避開 +／/／=
 * 這些需要百分比編碼的字元，否則使用者從信件複製貼上時很容易斷掉。
 */
function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** 與 auth.ts 的 session token 同一套雜湊方式（SHA-256 → hex）。 */
async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// 設定值
// ---------------------------------------------------------------------------

async function readSetting(db: D1Database, key: string): Promise<string> {
  const row = await db.prepare(
    "SELECT setting_value AS value FROM settings WHERE setting_key = ?",
  ).bind(key).first<{ value: string }>();
  return row?.value ?? "";
}

/**
 * settings 表有多支端點可寫（見 settings.ts 檔頭），讀取端不能假設值一定合法：
 * 型別錯、超出範圍、被刪掉都可能發生。任何不合法的值一律退回預設 24 小時，
 * 而不是讓 expires_at 變成 NaN 導致所有連結立刻失效或永不過期。
 */
export async function passwordSetupHours(db: D1Database): Promise<number> {
  const parsed = Number(await readSetting(db, SETTING_HOURS));
  if (!Number.isInteger(parsed) || parsed < MIN_TOKEN_HOURS || parsed > MAX_TOKEN_HOURS) {
    return DEFAULT_TOKEN_HOURS;
  }
  return parsed;
}

/** 去掉結尾斜線，讓 `${base}/?setup=` 不會組出 `//?setup=`。 */
async function appBaseUrl(db: D1Database): Promise<string> {
  return (await readSetting(db, SETTING_BASE_URL)).trim().replace(/\/+$/, "");
}

/**
 * 連結格式固定為 `{app_base_url}/?setup={token}`。
 *
 * 一定要走根路徑加 query，不能用 /password-setup/{token} 這種路徑：
 * 前端是沒有 router 的 SPA，Cloudflare Pages 對非根路徑會直接回 404，
 * 使用者連頁面都看不到。
 *
 * app_base_url 未設定時回傳相對路徑。這個值仍然可用——admin 在同網域的管理
 * 介面上點得開，也能自行接上網域後轉達——但系統不會拿它寄信。
 */
function buildSetupUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/?setup=${token}`;
}

// ---------------------------------------------------------------------------
// 發放
// ---------------------------------------------------------------------------

export interface PasswordSetupDelivery {
  /** 寄信結果。status 沿用 mailer.ts 的三種狀態，訊息為可直接顯示的繁中說明。 */
  mail: { status: "sent" | "skipped" | "failed"; message: string };
  /** 只有在「信沒有真的寄出去」時才出現，讓 admin 有手動轉達的退路。 */
  setupUrl?: string;
  expiresAt: string;
}

function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  // 固定三顆星，不用 local.length 補星號——那會洩漏帳號長度。
  return `${local.slice(0, local.length <= 2 ? 1 : 2)}***${email.slice(at)}`;
}

function mailSubject(purpose: SetupPurpose): string {
  return purpose === "account_setup" ? "【人資系統】帳號開通：請設定您的登入密碼" : "【人資系統】密碼重設連結";
}

/**
 * 信件內文。**不得包含任何密碼**——這正是改用連結的全部理由。
 * 也刻意寫明「本系統不會以 email 索取密碼」，降低使用者被釣魚的機會。
 */
function mailBody(purpose: SetupPurpose, url: string, hours: number): string {
  const opening = purpose === "account_setup"
    ? "系統管理員已為您建立人資系統的登入帳號。"
    : "我們收到您的人資系統密碼設定需求。";
  return [
    "您好：",
    "",
    opening,
    `請於 ${hours} 小時內點擊下列連結，親自設定登入密碼：`,
    "",
    url,
    "",
    "提醒您：",
    "1. 本連結僅能使用一次，密碼設定完成後即失效。",
    `2. 連結有效時間為 ${hours} 小時，逾期請於登入頁使用「忘記密碼」重新申請，或聯絡系統管理員。`,
    "3. 密碼設定完成後，您在其他裝置上的登入狀態會全部登出，請重新登入。",
    "4. 本系統不會、也不應在信件中提供或索取您的密碼。任何要求您以 email 回覆密碼的訊息都不是本系統發出的。",
    "5. 若您並未提出此需求，請忽略本信，並儘速通知系統管理員。",
    "",
    "此信件由系統自動發送，請勿直接回覆。",
  ].join("\n");
}

/**
 * 為指定帳號發放一次性設定連結，並在條件允許時寄出通知信。
 *
 * **絕不拋例外**（除了資料庫真的掛掉）。呼叫端是建立帳號／重設密碼——帳號在此
 * 之前已經寫進資料庫了，寄信失敗卻讓整個請求回 5xx，會讓 admin 誤以為沒建成而
 * 重試，反而製造重複帳號或重複作廢密碼。原則與 mailer.ts 檔頭一致。
 */
export async function issuePasswordSetup(
  env: unknown,
  db: D1Database,
  user: { id: string; email: string },
  purpose: SetupPurpose,
): Promise<PasswordSetupDelivery> {
  const hours = await passwordSetupHours(db);
  const token = generateToken();
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + hours * 3_600_000).toISOString();

  await db.batch([
    // 最後發出的連結才算數：同一帳號先前尚未使用的連結一律作廢，
    // 避免「重設兩次後兩條連結都能用」這種超出預期的有效期。
    db.prepare("DELETE FROM password_setup_tokens WHERE user_id = ? AND used_at IS NULL").bind(user.id),
    db.prepare(`
      INSERT INTO password_setup_tokens (id, user_id, token_hash, purpose, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(uuid(), user.id, tokenHash, purpose, expiresAt),
  ]);

  const baseUrl = await appBaseUrl(db);
  if (!baseUrl) {
    return {
      mail: {
        status: "skipped",
        message: "系統尚未設定對外網址（設定項目 app_base_url），為避免寄出指向錯誤網域的連結，"
          + "系統未寄送設定信。請改由管理員將下方連結轉交本人。",
      },
      setupUrl: buildSetupUrl("", token),
      expiresAt,
    };
  }

  const result = await sendMail(env, {
    to: user.email,
    subject: mailSubject(purpose),
    text: mailBody(purpose, buildSetupUrl(baseUrl, token), hours),
  });

  if (result.status === "sent") {
    // 寄出成功就不回傳 setupUrl：連結已經在本人信箱裡，沒有理由再讓它多一份
    // 停留在 admin 的畫面上。
    return {
      mail: { status: "sent", message: `密碼設定連結已寄至 ${user.email}，有效 ${hours} 小時，僅能使用一次。` },
      expiresAt,
    };
  }

  const reason = result.status === "skipped"
    ? "系統未設定寄信服務，未寄送設定信。"
    : `設定信寄送失敗：${result.reason}`;
  return {
    mail: { status: result.status, message: `${reason}請改由管理員將下方連結轉交本人。` },
    setupUrl: buildSetupUrl(baseUrl, token),
    expiresAt,
  };
}

// ---------------------------------------------------------------------------
// 驗證
// ---------------------------------------------------------------------------

interface TokenRow {
  id: string;
  userId: string;
  email: string;
  purpose: SetupPurpose;
  expiresAt: string;
  usedAt: string | null;
  active: number;
  archivedAt: string | null;
}

/**
 * 三種失效情況刻意用不同狀態碼與訊息，讓前端能給出對的下一步指示：
 *   404 連結不存在（打錯字、被截斷、或早已被新連結取代）→ 請重新申請。
 *   410 曾經有效但已用過／已過期 → 語意是「這條路走過了」，同樣請重新申請。
 * 但**都不得洩漏這個 token 曾屬於哪個帳號**：失效訊息裡沒有任何 email、姓名或
 * 帳號狀態，否則手上有一堆過期連結的人就能反查誰在這個系統裡。
 * 只有驗證通過的情況才回遮罩後的 email，供本人確認沒設定到別人的帳號。
 */
async function loadToken(db: D1Database, token: string): Promise<TokenRow> {
  const row = await db.prepare(`
    SELECT t.id, t.user_id AS userId, t.purpose, t.expires_at AS expiresAt, t.used_at AS usedAt,
           u.email, u.active, u.archived_at AS archivedAt
    FROM password_setup_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ?
  `).bind(await hashToken(token)).first<TokenRow>();

  if (!row) {
    throw new ApiError(404, "此連結無效，請確認網址是否完整。若連結已失效，請重新申請或聯絡系統管理員。", {
      valid: false,
      reason: "not_found",
    });
  }
  if (row.usedAt) {
    throw new ApiError(410, "此連結已經使用過，無法重複設定密碼。若需再次設定，請使用「忘記密碼」重新申請。", {
      valid: false,
      reason: "used",
    });
  }
  if (row.expiresAt <= new Date().toISOString()) {
    throw new ApiError(410, "此連結已過期。請使用「忘記密碼」重新申請，或聯絡系統管理員重新發送。", {
      valid: false,
      reason: "expired",
    });
  }
  if (row.active !== 1 || row.archivedAt) {
    // 不說「帳號已停用」——那等於用一條過期連結就能問出某帳號的狀態。
    throw new ApiError(410, "此連結已失效，請聯絡系統管理員。", { valid: false, reason: "unavailable" });
  }
  return row;
}

async function inspectToken(db: D1Database, token: string): Promise<Response> {
  const row = await loadToken(db, token);
  return json({
    valid: true,
    emailMasked: maskEmail(row.email),
    purpose: row.purpose,
    expiresAt: row.expiresAt,
  });
}

interface CompleteBody {
  token?: unknown;
  newPassword?: unknown;
}

/**
 * 設定新密碼。步驟順序是刻意的：
 *   1. 先驗 token、再驗密碼強度——弱密碼被擋下時 token 必須維持可用，
 *      使用者才能直接重打一次而不必重新申請連結。
 *   2. 密碼都備妥後才「消耗」token，且用 `WHERE used_at IS NULL` 條件式更新
 *      並檢查 changes：兩個並行請求只有一個會拿到 1，另一個吃 410。
 *      單純先讀後寫擋不住併發重放。
 *   3. 最後才寫入新密碼並清掉 sessions。
 * 第 3 步失敗會留下一張已消耗但沒改成密碼的 token（使用者需重新申請）；
 * 相較於「token 可能被用兩次」，這個方向的失敗明顯比較安全。
 */
async function completeSetup(request: Request, db: D1Database): Promise<Response> {
  const body = await parseJson<CompleteBody>(request);
  const token = requiredString(body.token, "設定連結", 500);
  const newPassword = requiredString(body.newPassword, "新密碼", 200);

  const row = await loadToken(db, token);
  assertPasswordStrength(newPassword);
  const credentials = await hashPassword(newPassword);

  const consumed = await db.prepare(`
    UPDATE password_setup_tokens
    SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND used_at IS NULL
  `).bind(row.id).run();
  if ((consumed.meta.changes ?? 0) === 0) {
    throw new ApiError(410, "此連結已經使用過，無法重複設定密碼。若需再次設定，請使用「忘記密碼」重新申請。", {
      valid: false,
      reason: "used",
    });
  }

  await db.batch([
    db.prepare(`
      UPDATE users
      SET password_hash = ?, password_salt = ?, password_iterations = ?, must_change_password = 0
      WHERE id = ?
    `).bind(credentials.hash, credentials.salt, credentials.iterations, row.userId),
    // 帳號可能正被他人登入著——這往往就是使用者跑來重設密碼的原因。
    // 只換密碼而不清 sessions，對方的 cookie 仍然有效，等於沒把人踢出去。
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(row.userId),
    // 其餘未使用的連結一併作廢（正常情況下發放時已清過，這裡是防禦性收尾）。
    db.prepare("DELETE FROM password_setup_tokens WHERE user_id = ? AND used_at IS NULL").bind(row.userId),
    // actor 為 NULL：這是未登入的公開端點，沒有「操作者帳號」可記。
    // 一併避免在 audit_logs.actor_user_id 上新增指向該帳號的參照，
    // 那會被 accounts.ts 的 auditRefCount 算進去而改變刪除／封存判斷。
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, details)
      VALUES (?, NULL, 'user.password_setup', 'user', ?, ?)
    `).bind(uuid(), row.userId, JSON.stringify({ purpose: row.purpose })),
  ]);

  return json({
    success: true,
    purpose: row.purpose,
    message: "密碼已設定完成，請使用新密碼登入。其他裝置上的登入狀態已全部登出。",
  });
}

// ---------------------------------------------------------------------------
// 忘記密碼
// ---------------------------------------------------------------------------

/**
 * 不論 email 是否存在、帳號是否停用或封存，一律回這一句、一律 200。
 * 只要回應有任何差異（訊息、狀態碼、欄位有無），就等於提供了帳號列舉的旁路：
 * 任何人都能拿一份 email 清單來問出誰在這個系統裡。
 */
const FORGOT_PASSWORD_MESSAGE =
  "若這個電子郵件對應到系統中可用的帳號，我們已寄出密碼設定連結，請於數分鐘內查收（包含垃圾郵件匣）。";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function forgotPassword(request: Request, env: { DB: D1Database }): Promise<Response> {
  const body = await parseJson<{ email?: unknown }>(request);
  const email = requiredString(body.email, "電子郵件", 200).toLowerCase();

  // 格式不合法也不另外報錯——422 與 200 的差異一樣是可觀察的訊號。
  if (EMAIL_PATTERN.test(email)) {
    const row = await env.DB.prepare(`
      SELECT id, email FROM users
      WHERE email = ? COLLATE NOCASE AND active = 1 AND archived_at IS NULL
    `).bind(email).first<{ id: string; email: string }>();
    if (row) {
      // 回傳值刻意整個丟棄：setupUrl 一旦出現在這支公開端點的回應裡，
      // 任何人輸入別人的 email 就能直接拿到對方的密碼設定連結。
      await issuePasswordSetup(env, env.DB, row, "password_reset");
    }
  }

  return json({ message: FORGOT_PASSWORD_MESSAGE });
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

/**
 * 三支都是**公開端點**，必須註冊在 router.ts 需要登入的檢查之前：
 * 會用到它們的人，正好就是還沒有密碼、登不進來的人。
 */
export async function handlePublicPasswordSetup(
  request: Request,
  env: { DB: D1Database },
  path: string,
): Promise<Response | null> {
  const method = request.method;

  const tokenMatch = path.match(/^\/api\/auth\/password-setup\/([^/]+)$/);
  if (tokenMatch?.[1] && method === "GET") {
    let token = tokenMatch[1];
    // base64url 本身不含需要百分比編碼的字元，但用戶端仍可能整段編碼後送來。
    try {
      token = decodeURIComponent(token);
    } catch {
      // 無效的百分比編碼：維持原字串，後續查不到自然回 404。
    }
    return inspectToken(env.DB, token);
  }
  if (path === "/api/auth/password-setup" && method === "POST") {
    return completeSetup(request, env.DB);
  }
  if (path === "/api/auth/forgot-password" && method === "POST") {
    return forgotPassword(request, env);
  }
  return null;
}
