import { useState } from "preact/hooks";
import { api, jsonBody } from "../api";

// 變更密碼對 admin 與 employee 是同一套流程（同一個 POST /api/auth/change-password），
// 因此抽為共用元件而非各自實作一份：寫兩份的話，日後調整密碼規則或錯誤訊息
// 只會改到其中一邊。
//
// 背景：登入流程會強制首次變更密碼，但先前只有員工的「個人資料」頁提供事後
// 變更的入口；admin 設完首次密碼後，介面上就再也沒有改密碼的途徑。

function Message({ text, error = false }: { text: string; error?: boolean }) {
  if (!text) return null;
  return <div class={`alert ${error ? "error" : "success"}`}>{text}</div>;
}

export function ChangePasswordPanel() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: Event) {
    event.preventDefault();
    setError("");
    setMessage("");
    if (newPassword !== confirmPassword) {
      setError("兩次輸入的新密碼不一致。");
      return;
    }
    setSaving(true);
    try {
      await api("/api/auth/change-password", {
        method: "POST",
        ...jsonBody({ currentPassword, newPassword }),
      });
      setMessage("密碼已變更，下次登入請使用新密碼。");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "密碼變更失敗。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form class="panel section-title" onSubmit={submit}>
      <div class="panel-heading"><h2>變更密碼</h2></div>
      <Message text={message} />
      <Message text={error} error />
      <div class="form-grid">
        <label class="full">目前密碼<input type="password" value={currentPassword} onInput={(event) => setCurrentPassword(event.currentTarget.value)} required /></label>
        <label>新密碼<input type="password" value={newPassword} onInput={(event) => setNewPassword(event.currentTarget.value)} required /></label>
        <label>再次輸入新密碼<input type="password" value={confirmPassword} onInput={(event) => setConfirmPassword(event.currentTarget.value)} required /></label>
      </div>
      <small>至少 10 碼，包含大小寫英文字母、數字與符號。</small>
      <div class="button-row"><button class="primary" disabled={saving}>{saving ? "更新中…" : "更新密碼"}</button></div>
    </form>
  );
}
