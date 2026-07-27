import { useEffect, useState } from "preact/hooks";
import { api } from "./api";
import { AdminApp } from "./pages/AdminApp";
import { EmployeeApp } from "./pages/EmployeeApp";
import { LoginPage } from "./pages/LoginPage";
import { SetPasswordPage } from "./pages/SetPasswordPage";
import type { User } from "./types";

/** 一次性密碼設定連結固定是 `{base}/?setup={token}`（本 SPA 沒有路由，見規格）。 */
function readSetupToken(): string | null {
  return new URLSearchParams(window.location.search).get("setup");
}

export function App() {
  const [setupToken, setSetupToken] = useState<string | null>(() => readSetupToken());
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    // 有 setup token 時，使用者多半是從信件連結點進來、尚未登入：
    // 這種情況下不應該先打 /api/auth/me，直接交給 SetPasswordPage 處理。
    if (setupToken) return;
    setChecking(true);
    void api<{ user: User }>("/api/auth/me")
      .then((result) => setUser(result.user))
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, [setupToken]);

  async function logout() {
    try { await api("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); }
    finally { setUser(null); }
  }

  if (setupToken) return <SetPasswordPage token={setupToken} onDone={() => setSetupToken(null)} />;
  if (checking) return <div class="loading-screen"><div class="brand-mark">HR</div><p>載入中…</p></div>;
  if (!user || user.mustChangePassword) return <LoginPage onAuthenticated={setUser} />;
  if (user.role === "admin") return <AdminApp user={user} onLogout={() => void logout()} />;
  return <EmployeeApp user={user} onLogout={() => void logout()} />;
}
