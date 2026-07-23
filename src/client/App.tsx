import { useEffect, useState } from "preact/hooks";
import { api } from "./api";
import { AdminApp } from "./pages/AdminApp";
import { EmployeeApp } from "./pages/EmployeeApp";
import { LoginPage } from "./pages/LoginPage";
import type { User } from "./types";

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    void api<{ user: User }>("/api/auth/me")
      .then((result) => setUser(result.user))
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, []);

  async function logout() {
    try { await api("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); }
    finally { setUser(null); }
  }

  if (checking) return <div class="loading-screen"><div class="brand-mark">HR</div><p>載入中…</p></div>;
  if (!user || user.mustChangePassword) return <LoginPage onAuthenticated={setUser} />;
  if (user.role === "admin") return <AdminApp user={user} onLogout={() => void logout()} />;
  return <EmployeeApp user={user} onLogout={() => void logout()} />;
}
