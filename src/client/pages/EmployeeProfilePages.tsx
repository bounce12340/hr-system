import { useEffect, useState } from "preact/hooks";
import { api, jsonBody } from "../api";
import type { EmployeeProfile } from "../types";

// ---- 個人資料（規格 §七 Employee 導覽：個人資料）----
// 對應後端 GET/PATCH /api/employee/profile。只能改姓名與 email，其餘欄位由
// HR 於員工管理維護，此頁一律唯讀顯示，不做成看似可編輯的輸入框。
// 密碼變更沿用既有 POST /api/auth/change-password（見 src/server/auth.ts）。

function Message({ text, error = false }: { text: string; error?: boolean }) {
  if (!text) return null;
  return <div class={`alert ${error ? "error" : "success"}`}>{text}</div>;
}

export function MyProfilePage() {
  const [profile, setProfile] = useState<EmployeeProfile | null>(null);
  const [form, setForm] = useState({ name: "", email: "" });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const data = await api<{ employee: EmployeeProfile }>("/api/employee/profile");
      setProfile(data.employee);
      setForm({ name: data.employee.name, email: data.employee.email });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法讀取個人資料。");
    }
  }
  useEffect(() => { void load(); }, []);

  async function save(event: Event) {
    event.preventDefault();
    setError("");
    setMessage("");
    setSaving(true);
    try {
      await api("/api/employee/profile", { method: "PATCH", ...jsonBody(form) });
      setMessage("個人資料已更新。");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "更新失敗，請確認欄位內容。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <div class="page-heading">
        <div>
          <p class="eyebrow">MY PROFILE</p>
          <h1>個人資料</h1>
          <p>可自行更新姓名與聯絡信箱；其餘由人資部門統一維護的欄位僅供查看。</p>
        </div>
      </div>
      <Message text={message} />
      <Message text={error} error />

      <div class="split-layout">
        <form class="panel sticky-form" onSubmit={save}>
          <h2>可編輯欄位</h2>
          <label>姓名<input value={form.name} onInput={(event) => setForm({ ...form, name: event.currentTarget.value })} required /></label>
          <label>聯絡信箱<input type="email" value={form.email} onInput={(event) => setForm({ ...form, email: event.currentTarget.value })} required /></label>
          <div class="button-row"><button class="primary" disabled={saving}>{saving ? "儲存中…" : "儲存變更"}</button></div>
        </form>

        <div class="panel">
          <h2>人資資料（唯讀）</h2>
          <dl class="info-grid">
            <div class="info-field"><dt>員工編號</dt><dd>{profile?.employeeNo ?? "—"}</dd></div>
            <div class="info-field"><dt>部門</dt><dd>{profile?.department ?? "—"}</dd></div>
            <div class="info-field"><dt>職等</dt><dd>{profile?.grade ?? "—"}</dd></div>
            <div class="info-field"><dt>職稱</dt><dd>{profile?.title ?? "—"}</dd></div>
            <div class="info-field"><dt>職務類型</dt><dd>{profile?.jobType ?? "—"}</dd></div>
            <div class="info-field"><dt>到職日</dt><dd>{profile?.hireDate ?? "—"}</dd></div>
          </dl>
          <small>以上欄位由人資部門管理，如需更正請聯繫 HR。</small>
        </div>
      </div>

      <ChangePasswordPanel />
    </section>
  );
}

function ChangePasswordPanel() {
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
