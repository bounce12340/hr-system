import { useState } from "preact/hooks";
import { api, jsonBody } from "../api";
import type { User } from "../types";

interface LoginPageProps {
  onAuthenticated: (user: User) => void;
}

export function LoginPage({ onAuthenticated }: LoginPageProps) {
  const [email, setEmail] = useState("admin@demo.local");
  const [password, setPassword] = useState("Demo1234!");
  const [pendingUser, setPendingUser] = useState<User | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submitLogin(event: Event) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const result = await api<{ user: User }>("/api/auth/login", {
        method: "POST",
        ...jsonBody({ email, password }),
      });
      if (result.user.mustChangePassword) setPendingUser(result.user);
      else onAuthenticated(result.user);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登入失敗。");
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

  return (
    <main class="login-page">
      <section class="login-panel">
        <div class="brand-mark">HR</div>
        <p class="eyebrow">HR LEARNING PLATFORM</p>
        <h1>{pendingUser ? "首次登入，請設定新密碼" : "人資學習排課系統"}</h1>
        <p class="muted-copy">
          {pendingUser ? "完成密碼更新後即可開始使用。" : "內部教育訓練與排課工作台"}
        </p>
        {error && <div class="alert error" role="alert">{error}</div>}
        {!pendingUser ? (
          <form class="stack-form" onSubmit={submitLogin}>
            <label>電子郵件<input value={email} onInput={(event) => setEmail(event.currentTarget.value)} type="email" required /></label>
            <label>密碼<input value={password} onInput={(event) => setPassword(event.currentTarget.value)} type="password" required /></label>
            <button class="primary" disabled={loading}>{loading ? "登入中…" : "登入"}</button>
          </form>
        ) : (
          <form class="stack-form" onSubmit={changePassword}>
            <label>新密碼<input value={newPassword} onInput={(event) => setNewPassword(event.currentTarget.value)} type="password" required /></label>
            <label>再次輸入<input value={confirmPassword} onInput={(event) => setConfirmPassword(event.currentTarget.value)} type="password" required /></label>
            <small>至少 10 碼，包含大小寫英文字母、數字與符號。</small>
            <button class="primary" disabled={loading}>{loading ? "更新中…" : "更新密碼並進入"}</button>
          </form>
        )}
        {!pendingUser && <p class="demo-hint">Demo admin：admin@demo.local／Demo1234!</p>}
      </section>
      <aside class="login-visual">
        <p>Learning operations</p>
        <strong>把每一場訓練，安排給真正需要的人。</strong>
        <span>排課・衝突檢查・出席・完訓追蹤</span>
      </aside>
    </main>
  );
}
