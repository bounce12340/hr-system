import { useEffect, useState } from "preact/hooks";
import { api, jsonBody } from "../api";
import { TurnstileWidget } from "../turnstile";
import type { User } from "../types";

interface LoginPageProps {
  onAuthenticated: (user: User) => void;
}

type LoginMode = "login" | "forgot";

/**
 * 忘記密碼一律顯示這句話，不論輸入的電子郵件是否對應真實帳號——這是後端刻意
 * 的設計（POST /api/auth/forgot-password 一律回 200），前端不可依回應內容
 * 推斷帳號是否存在，否則等於幫攻擊者驗證哪些信箱有註冊。
 */
const FORGOT_PASSWORD_NOTICE = "若該電子郵件對應有效帳號，我們已寄出設定密碼的連結，請至信箱查看（含垃圾信件匣）。";

/**
 * 是否為本機開發環境。
 *
 * demo 帳密的預填與提示只在本機出現：部署後的站台是公開可存取的，若在登入頁
 * 預填或標示管理者帳密，等於任何取得網址的人都能直接進入管理後台。
 */
function isLocalDevHost(): boolean {
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
}

export function LoginPage({ onAuthenticated }: LoginPageProps) {
  const localDev = isLocalDevHost();
  const [email, setEmail] = useState(localDev ? "admin@demo.local" : "");
  const [password, setPassword] = useState(localDev ? "Demo1234!" : "");
  const [pendingUser, setPendingUser] = useState<User | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const [mode, setMode] = useState<LoginMode>("login");
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotSubmitting, setForgotSubmitting] = useState(false);
  const [forgotError, setForgotError] = useState("");
  const [forgotSubmitted, setForgotSubmitted] = useState(false);
  const [forgotNotice, setForgotNotice] = useState(FORGOT_PASSWORD_NOTICE);

  // undefined = 還在問後端；null = 後端未啟用 Turnstile；字串 = 要顯示驗證框。
  // 三態是必要的：分不出「未啟用」與「還沒問到」的話，只能二選一——不是在
  // 未啟用的環境憑空多出一個框，就是在已啟用的環境讓使用者送出必被擋的請求。
  const [siteKey, setSiteKey] = useState<string | null | undefined>(undefined);
  const [loginToken, setLoginToken] = useState("");
  const [loginResetKey, setLoginResetKey] = useState(0);
  const [forgotToken, setForgotToken] = useState("");
  const [forgotResetKey, setForgotResetKey] = useState(0);

  useEffect(() => {
    void api<{ turnstileSiteKey: string | null }>("/api/public-config")
      .then((config) => setSiteKey(config.turnstileSiteKey))
      // 問不到就當作未啟用，讓使用者仍能嘗試登入。若後端其實有啟用，這次送出
      // 會被擋下並顯示錯誤——比在這裡直接鎖死表單、連錯誤訊息都看不到要好。
      .catch(() => setSiteKey(null));
  }, []);

  // 驗證框存在時，沒有 token 就不讓送出：省掉一次註定 403 的往返。
  const turnstilePending = siteKey === undefined;
  const loginBlocked = turnstilePending || (siteKey !== null && loginToken === "");
  const forgotBlocked = turnstilePending || (siteKey !== null && forgotToken === "");

  function openForgotPassword() {
    setMode("forgot");
    setForgotError("");
    setForgotSubmitted(false);
  }

  function backToLogin() {
    setMode("login");
    setForgotError("");
    setForgotSubmitted(false);
  }

  async function submitLogin(event: Event) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const result = await api<{ user: User }>("/api/auth/login", {
        method: "POST",
        ...jsonBody({ email, password, turnstileToken: loginToken }),
      });
      if (result.user.mustChangePassword) setPendingUser(result.user);
      else onAuthenticated(result.user);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登入失敗。");
      // 送出過的 token 已作廢，且表單留在原地讓使用者再試一次——不重設的話，
      // 第二次送的是同一個死 token，會變成「密碼明明打對了卻一直登不進去」。
      setLoginResetKey((key) => key + 1);
    } finally {
      setLoading(false);
    }
  }

  async function changePassword(event: Event) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setError("兩次輸入的新密碼不一致。");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const result = await api<{ user: User }>("/api/auth/change-password", {
        method: "POST",
        ...jsonBody({ currentPassword: password, newPassword }),
      });
      onAuthenticated(result.user);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "密碼變更失敗。");
    } finally {
      setLoading(false);
    }
  }

  async function submitForgotPassword(event: Event) {
    event.preventDefault();
    setForgotError("");
    setForgotSubmitting(true);
    try {
      // 後端（src/server/password-setup.ts forgotPassword）不論帳號是否存在
      // 一律回 200 且訊息完全相同；直接顯示它回傳的 message 即可，不必在前端
      // 另外編一份文案，兩邊永遠一致。
      const result = await api<{ message: string }>("/api/auth/forgot-password", {
        method: "POST",
        ...jsonBody({ email: forgotEmail, turnstileToken: forgotToken }),
      });
      setForgotNotice(result.message || FORGOT_PASSWORD_NOTICE);
      setForgotSubmitted(true);
    } catch (caught) {
      // 這裡會顯示錯誤的前提是送出本身失敗（網路或伺服器問題），而不是「查無
      // 此帳號」——後端一律回 200，帳號是否存在永遠不會反映在這個分支。
      setForgotError(caught instanceof Error ? caught.message : "送出失敗，請稍後再試。");
      setForgotResetKey((key) => key + 1);
    } finally {
      setForgotSubmitting(false);
    }
  }

  return (
    <main class="login-page">
      <section class="login-panel">
        <div class="brand-mark">HR</div>
        <p class="eyebrow">HR LEARNING PLATFORM</p>
        <h1>{pendingUser ? "首次登入，請設定新密碼" : mode === "forgot" ? "忘記密碼" : "人資學習排課系統"}</h1>
        <p class="muted-copy">
          {pendingUser
            ? "完成密碼更新後即可開始使用。"
            : mode === "forgot"
              ? "輸入登入用的電子郵件，我們會寄送設定密碼的連結。"
              : "內部教育訓練與排課工作台"}
        </p>
        {error && <div class="alert error" role="alert">{error}</div>}
        {mode === "forgot" ? (
          <>
            {forgotError && <div class="alert error" role="alert">{forgotError}</div>}
            {forgotSubmitted ? (
              <div class="alert success" role="status">{forgotNotice}</div>
            ) : (
              <form class="stack-form" onSubmit={submitForgotPassword}>
                <label>
                  電子郵件
                  <input
                    value={forgotEmail}
                    onInput={(event) => setForgotEmail(event.currentTarget.value)}
                    type="email"
                    required
                  />
                </label>
                {/*
                  key 是必要的，不是裝飾。登入表單與這個表單的 <TurnstileWidget>
                  在各自 <form class="stack-form"> 中的型別與位置相同，Preact 會
                  判定為同一個元件而只更新 props：widget 不會重新掛載，effect
                  的相依（siteKey）也沒變不會重跑，於是已經發出的 token 仍記在
                  loginToken，forgotToken 永遠是空字串——送出鈕就永遠鎖住，
                  沒有人能申請重設密碼。給兩處不同的 key 才會真正重新掛載。
                */}
                {siteKey && (
                  <TurnstileWidget key="forgot" siteKey={siteKey} onToken={setForgotToken} resetKey={forgotResetKey} />
                )}
                <button class="primary" disabled={forgotSubmitting || forgotBlocked}>
                  {forgotSubmitting ? "送出中…" : "寄送設定密碼連結"}
                </button>
              </form>
            )}
            <button type="button" class="login-link-button" onClick={backToLogin}>回登入頁</button>
          </>
        ) : !pendingUser ? (
          <>
            <form class="stack-form" onSubmit={submitLogin}>
              <label>電子郵件<input value={email} onInput={(event) => setEmail(event.currentTarget.value)} type="email" required /></label>
              <label>密碼<input value={password} onInput={(event) => setPassword(event.currentTarget.value)} type="password" required /></label>
              {siteKey && (
                <TurnstileWidget key="login" siteKey={siteKey} onToken={setLoginToken} resetKey={loginResetKey} />
              )}
              <button class="primary" disabled={loading || loginBlocked}>{loading ? "登入中…" : "登入"}</button>
            </form>
            <button type="button" class="login-link-button" onClick={openForgotPassword}>忘記密碼？</button>
          </>
        ) : (
          <form class="stack-form" onSubmit={changePassword}>
            <label>新密碼<input value={newPassword} onInput={(event) => setNewPassword(event.currentTarget.value)} type="password" required /></label>
            <label>再次輸入<input value={confirmPassword} onInput={(event) => setConfirmPassword(event.currentTarget.value)} type="password" required /></label>
            <small>至少 10 碼，包含大小寫英文字母、數字與符號。</small>
            <button class="primary" disabled={loading}>{loading ? "更新中…" : "更新密碼並進入"}</button>
          </form>
        )}
        {mode === "login" && !pendingUser && localDev && (
          <p class="demo-hint">Demo admin：admin@demo.local／Demo1234!</p>
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
