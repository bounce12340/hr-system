import { useEffect, useState } from "preact/hooks";
import { api, ApiClientError, jsonBody } from "../api";

interface SetPasswordPageProps {
  /** 從網址 `?setup=` 參數讀出的 token（見 App.tsx）。 */
  token: string;
  /** 設定完成或使用者放棄時呼叫，讓 App.tsx 清掉 setup 狀態、回到一般登入流程。 */
  onDone: () => void;
}

type LinkState = "loading" | "valid" | "unavailable" | "error";

interface LinkInfo {
  emailMasked: string;
  purpose: string;
  expiresAt: string | null;
}

const EMPTY_INFO: LinkInfo = { emailMasked: "", purpose: "", expiresAt: null };

/**
 * GET /api/auth/password-setup/{token} 對應 src/server/password-setup.ts：
 * 成功一律 200 回 `{ valid: true, emailMasked, purpose, expiresAt }`；不可用時
 * **不是** 200 + valid:false，而是 404（不存在）或 410（已使用／已過期／帳號停用），
 * 錯誤訊息與原因放在 ApiError 的 details：`{ valid: false, reason }`
 * （reason 為 "not_found" | "used" | "expired" | "unavailable"，見該檔
 * loadToken）。因此這裡改抓 ApiClientError 的 message／details，不必自己
 * 重新編一套文案——後端訊息已經是可直接顯示的繁中說明。
 */
function readSetupReason(details: unknown): string {
  if (!details || typeof details !== "object") return "";
  const value = (details as Record<string, unknown>).reason;
  return typeof value === "string" ? value : "";
}

function formatDateTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString("zh-TW");
}

export function SetPasswordPage({ token, onDone }: SetPasswordPageProps) {
  const [state, setState] = useState<LinkState>("loading");
  const [info, setInfo] = useState<LinkInfo>(EMPTY_INFO);
  const [unavailableMessage, setUnavailableMessage] = useState("");
  const [unavailableReason, setUnavailableReason] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    let alive = true;
    setState("loading");
    api<{ valid: true; emailMasked: string; purpose: string; expiresAt: string }>(
      `/api/auth/password-setup/${encodeURIComponent(token)}`,
    )
      .then((data) => {
        if (!alive) return;
        setInfo({ emailMasked: data.emailMasked, purpose: data.purpose, expiresAt: data.expiresAt });
        setState("valid");
      })
      .catch((caught) => {
        if (!alive) return;
        if (caught instanceof ApiClientError) {
          setUnavailableMessage(caught.message);
          setUnavailableReason(readSetupReason(caught.details));
        } else {
          setUnavailableMessage("驗證連結時發生問題，請稍後再試。");
          setUnavailableReason("");
        }
        setState("unavailable");
      });
    return () => {
      alive = false;
    };
  }, [token]);

  async function submit(event: Event) {
    event.preventDefault();
    setFormError("");
    if (newPassword !== confirmPassword) {
      setFormError("兩次輸入的新密碼不一致。");
      return;
    }
    setSubmitting(true);
    try {
      await api("/api/auth/password-setup", {
        method: "POST",
        ...jsonBody({ token, newPassword }),
      });
      // 網址上的 token 完成使命即清除：避免留在瀏覽器歷史，也避免分享網址時外洩。
      window.history.replaceState(null, "", window.location.pathname);
      setCompleted(true);
    } catch (caught) {
      // 密碼強度規則由後端驗證（auth.ts assertPasswordStrength），這裡直接
      // 顯示其訊息，前端不重複一份規則、也不用猜後端到底檢查了什麼。
      // 若剛好在這中間 token 已被別的分頁用掉，訊息一樣會是後端給的原因。
      setFormError(caught instanceof Error ? caught.message : "設定密碼失敗，請稍後再試。");
    } finally {
      setSubmitting(false);
    }
  }

  const purposeLabel = info.purpose === "password_reset" ? "重設密碼" : "設定密碼";

  return (
    <main class="login-page">
      <section class="login-panel">
        <div class="brand-mark">HR</div>
        <p class="eyebrow">HR LEARNING PLATFORM</p>

        {completed ? (
          <>
            <h1>密碼已設定完成</h1>
            <p class="muted-copy">請使用新密碼重新登入，其他裝置上的登入狀態已全部登出。</p>
            <div class="button-row">
              <button type="button" class="primary" onClick={onDone}>前往登入</button>
            </div>
          </>
        ) : state === "loading" ? (
          <>
            <h1>設定密碼</h1>
            <p class="muted-copy">正在驗證連結，請稍候…</p>
          </>
        ) : state === "valid" ? (
          <>
            <h1>{purposeLabel}</h1>
            <p class="muted-copy">
              帳號：{info.emailMasked || "（無法顯示）"}
              {info.expiresAt && <><br />此連結將於 {formatDateTime(info.expiresAt)} 失效。</>}
            </p>
            {formError && <div class="alert error" role="alert">{formError}</div>}
            <form class="stack-form" onSubmit={submit}>
              <label>
                新密碼
                <input
                  value={newPassword}
                  onInput={(event) => setNewPassword(event.currentTarget.value)}
                  type="password"
                  autocomplete="new-password"
                  required
                />
              </label>
              <label>
                再次輸入
                <input
                  value={confirmPassword}
                  onInput={(event) => setConfirmPassword(event.currentTarget.value)}
                  type="password"
                  autocomplete="new-password"
                  required
                />
              </label>
              <small>至少 10 碼，包含大小寫英文字母、數字與符號。</small>
              <button class="primary" disabled={submitting}>{submitting ? "設定中…" : "設定密碼並前往登入"}</button>
            </form>
          </>
        ) : (
          <>
            <h1>連結無法使用</h1>
            <div class="alert error" role="alert">{unavailableMessage || "此連結無效，請重新申請一次。"}</div>
            <p class="muted-copy">
              {unavailableReason === "used"
                ? "若這不是您本人的操作，或您忘記了密碼，請於登入頁使用「忘記密碼」重新申請連結。"
                : "請於登入頁使用「忘記密碼」重新申請連結，或聯絡系統管理員協助。"}
            </p>
            <div class="button-row">
              <button type="button" class="secondary" onClick={onDone}>回登入頁</button>
            </div>
          </>
        )}
      </section>
      <aside class="login-visual">
        <p>Learning operations</p>
        <strong>把每一場訓練，安排給真正需要的人。</strong>
        <span>排課・衝突檢查・出席・完訓追蹤</span>
      </aside>
    </main>
  );
}
