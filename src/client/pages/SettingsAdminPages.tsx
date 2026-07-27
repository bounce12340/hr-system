import { useEffect, useState } from "preact/hooks";
import { api, ApiClientError, jsonBody } from "../api";
import { ChangePasswordPanel } from "../components/ChangePasswordPanel";
import type { JobType, SettingItem } from "../types";

// ---- 系統設定（規格 §七 Admin 導覽：系統設定）----
// 對應後端 GET/PATCH /api/admin/settings（一般參數）與
// GET/POST/PATCH/DELETE /api/admin/job-types（職務類型與必修級距映射，規格 §四 4.1）。
// 必修級距為累進：內勤＝低；診所線＝低＋中；醫院線＝低＋中＋高。

const LEVEL_LABEL = ["", "低", "中", "高"];

function Message({ text, error = false }: { text: string; error?: boolean }) {
  if (!text) return null;
  return <div class={`alert ${error ? "error" : "success"}`}>{text}</div>;
}

type SettingDraftValue = string | number | boolean;

function parseSettingValue(item: SettingItem): SettingDraftValue {
  if (item.valueType === "number") return Number(item.value);
  if (item.valueType === "boolean") return item.value === "true" || item.value === "1";
  return item.value;
}

export function SystemSettingsPage() {
  return (
    <section>
      <div class="page-heading">
        <div>
          <p class="eyebrow">SYSTEM SETTINGS</p>
          <h1>系統設定</h1>
          <p>維護提醒天數等系統參數，以及職務類型的必修級距映射。</p>
        </div>
      </div>
      {/*
        我的帳號放在系統設定頁而非另開分頁：admin 首次登入設定密碼後，介面上原本
        沒有任何再次變更的入口（API 一直是通的，缺的只是入口）。此處與員工的
        「個人資料」頁共用同一個元件。
      */}
      <ChangePasswordPanel />
      <MailSettingsPanel />
      <GeneralSettingsPanel />
      <JobTypesPanel />
    </section>
  );
}

/**
 * 寄信設定狀態與測試。
 *
 * AGENTMAIL_API_KEY／AGENTMAIL_INBOX_ID 是加密的 Cloudflare secret，設定後無法
 * 讀回檢查，設錯也只會在實際寄信時才失敗。此處提供主動驗證的入口。
 * 畫面上只顯示「是否已設定」，不顯示也不取得任何金鑰內容。
 */
function MailSettingsPanel() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [to, setTo] = useState("");
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void api<{ mailerConfigured?: boolean }>("/api/admin/settings")
      .then((data) => setConfigured(Boolean(data.mailerConfigured)))
      .catch(() => setConfigured(null));
  }, []);

  async function submit(event: Event) {
    event.preventDefault();
    setMessage("");
    setError("");
    setSending(true);
    try {
      const data = await api<{ result: { status: string }; message: string }>(
        "/api/admin/settings/mail-test",
        { method: "POST", ...jsonBody({ to }) },
      );
      if (data.result.status === "sent") setMessage(data.message);
      else setError(data.message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "測試信寄送失敗。");
    } finally {
      setSending(false);
    }
  }

  return (
    <form class="panel section-title" onSubmit={submit}>
      <div class="panel-heading">
        <h2>寄信服務</h2>
        {configured !== null && (
          <span class={`status ${configured ? "ok" : "warning"}`}>
            {configured ? "已設定" : "未設定"}
          </span>
        )}
      </div>
      <Message text={message} />
      <Message text={error} error />
      {configured === false && (
        <div class="alert warning">
          尚未設定寄信服務。請以 <code>wrangler pages secret put</code> 設定
          <code>AGENTMAIL_API_KEY</code> 與 <code>AGENTMAIL_INBOX_ID</code>，設定後重新部署即生效。
        </div>
      )}
      <label>
        測試收件者
        <input
          type="email"
          value={to}
          onInput={(event) => setTo(event.currentTarget.value)}
          placeholder="輸入你的信箱以接收測試信"
          required
        />
      </label>
      <div class="button-row">
        <button class="primary" disabled={sending || !to}>{sending ? "寄送中…" : "寄送測試信"}</button>
      </div>
    </form>
  );
}

function GeneralSettingsPanel() {
  const [settings, setSettings] = useState<SettingItem[]>([]);
  const [draft, setDraft] = useState<Record<string, SettingDraftValue>>({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    try {
      const data = await api<{ settings: SettingItem[] }>("/api/admin/settings");
      setSettings(data.settings);
      const next: Record<string, SettingDraftValue> = {};
      for (const item of data.settings) next[item.key] = parseSettingValue(item);
      setDraft(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法讀取系統設定。");
    } finally {
      setLoaded(true);
    }
  }
  useEffect(() => { void load(); }, []);

  function updateDraft(key: string, value: SettingDraftValue) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function saveAll(event: Event) {
    event.preventDefault();
    setError("");
    setMessage("");
    setSaving(true);
    try {
      const updates = settings.map((item) => ({ key: item.key, value: draft[item.key] }));
      await api("/api/admin/settings", { method: "PATCH", ...jsonBody({ updates }) });
      setMessage("設定已儲存。");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "儲存設定失敗。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form class="panel section-title" onSubmit={saveAll}>
      <div class="panel-heading"><h2>一般設定</h2></div>
      <Message text={message} />
      <Message text={error} error />
      {loaded && settings.length === 0 && !error && <div class="empty-state">目前沒有可設定的項目。</div>}
      {settings.length > 0 && (
        <>
          <div class="settings-list">
            {settings.map((item) => (
              <div class="settings-row" key={item.key}>
                <div>
                  <strong>{item.description || item.key}</strong>
                  <small>{item.key}</small>
                </div>
                {item.valueType === "boolean" ? (
                  <label class="switch">
                    <input
                      type="checkbox"
                      checked={Boolean(draft[item.key])}
                      onChange={(event) => updateDraft(item.key, event.currentTarget.checked)}
                    />
                    <span class="switch-track"><span class="switch-thumb" /></span>
                  </label>
                ) : item.valueType === "number" ? (
                  <input
                    type="number"
                    value={Number(draft[item.key] ?? 0)}
                    onInput={(event) => updateDraft(item.key, Number(event.currentTarget.value))}
                  />
                ) : (
                  <input
                    value={String(draft[item.key] ?? "")}
                    onInput={(event) => updateDraft(item.key, event.currentTarget.value)}
                  />
                )}
              </div>
            ))}
          </div>
          <div class="button-row"><button class="primary" disabled={saving}>{saving ? "儲存中…" : "儲存設定"}</button></div>
        </>
      )}
    </form>
  );
}

interface JobTypeForm {
  name: string;
  requiredLevel: number;
  active: boolean;
}

function emptyJobTypeForm(): JobTypeForm {
  return { name: "", requiredLevel: 1, active: true };
}

const REQUIRED_LEVEL_HELP: Record<number, string> = {
  1: "低（僅低階必修課程）",
  2: "低＋中（累進，低階與中階必修課程皆須完成）",
  3: "低＋中＋高（累進，低、中、高三階必修課程皆須完成）",
};

function JobTypesPanel() {
  const [jobTypes, setJobTypes] = useState<JobType[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<JobTypeForm>(emptyJobTypeForm());
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load() {
    try {
      const data = await api<{ jobTypes: JobType[] }>("/api/admin/job-types");
      setJobTypes(data.jobTypes);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法讀取職務類型。");
    }
  }
  useEffect(() => { void load(); }, []);

  function edit(jobType: JobType) {
    setEditingId(jobType.id);
    setForm({ name: jobType.name, requiredLevel: jobType.requiredLevel, active: jobType.active === 1 });
    setMessage("");
    setError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(emptyJobTypeForm());
  }

  async function save(event: Event) {
    event.preventDefault();
    setError("");
    setMessage("");
    const payload = { name: form.name, requiredLevel: form.requiredLevel, active: form.active };
    try {
      await api(editingId ? `/api/admin/job-types/${editingId}` : "/api/admin/job-types", {
        method: editingId ? "PATCH" : "POST",
        ...jsonBody(payload),
      });
      setMessage(editingId ? "職務類型已更新。" : "職務類型已建立。");
      setEditingId(null);
      setForm(emptyJobTypeForm());
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "儲存失敗，請確認欄位內容。");
    }
  }

  async function remove(jobType: JobType) {
    if (!confirm(`確定刪除職務類型「${jobType.name}」？`)) return;
    setError("");
    setMessage("");
    try {
      await api(`/api/admin/job-types/${jobType.id}`, { method: "DELETE" });
      setMessage(`職務類型「${jobType.name}」已刪除。`);
      await load();
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.status === 409) {
        setError(caught.message || `職務類型「${jobType.name}」目前仍有員工使用中，無法刪除。`);
      } else {
        setError(caught instanceof Error ? caught.message : "刪除失敗。");
      }
    }
  }

  return (
    <div class="panel section-title">
      <div class="panel-heading">
        <div>
          <h2>職務類型與必修級距</h2>
          <small>職務類型決定必修級距，且級距為累進關係。</small>
        </div>
      </div>
      <p class="muted-copy">提醒：調整必修級距不會回溯變更既有場次的應上名單，僅影響往後新排的場次與完訓計算。</p>
      <Message text={message} />
      <Message text={error} error />
      <div class="split-layout">
        <form class="panel sticky-form" onSubmit={save}>
          <h2>{editingId ? "編輯職務類型" : "新增職務類型"}</h2>
          <label>名稱<input value={form.name} onInput={(event) => setForm({ ...form, name: event.currentTarget.value })} required /></label>
          <label>
            必修級距（累進）
            <select value={form.requiredLevel} onChange={(event) => setForm({ ...form, requiredLevel: Number(event.currentTarget.value) })}>
              <option value="1">{REQUIRED_LEVEL_HELP[1]}</option>
              <option value="2">{REQUIRED_LEVEL_HELP[2]}</option>
              <option value="3">{REQUIRED_LEVEL_HELP[3]}</option>
            </select>
          </label>
          <label class="inline-check">
            <input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.currentTarget.checked })} /> 啟用
          </label>
          <div class="button-row">
            <button class="primary">{editingId ? "更新" : "建立"}</button>
            {editingId && <button type="button" class="secondary" onClick={cancelEdit}>取消</button>}
          </div>
        </form>
        <div class="table-card">
          <table>
            <thead><tr><th>名稱</th><th>必修級距（累進）</th><th>狀態</th><th /></tr></thead>
            <tbody>
              {jobTypes.map((jobType) => (
                <tr key={jobType.id}>
                  <td>
                    <strong>{jobType.name}</strong>
                    {typeof jobType.employeeCount === "number" && <small>{jobType.employeeCount} 位員工使用中</small>}
                  </td>
                  <td>
                    <div class="level-progress">
                      {[1, 2, 3].map((level) => (
                        <span class={`level-progress-seg level-${level} ${jobType.requiredLevel >= level ? "filled" : ""}`} key={level}>
                          {LEVEL_LABEL[level]}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td><span class={`status ${jobType.active ? "ok" : "muted"}`}>{jobType.active ? "啟用" : "停用"}</span></td>
                  <td>
                    <div class="row-actions">
                      <button onClick={() => edit(jobType)}>編輯</button>
                      <button class="danger-action" onClick={() => void remove(jobType)}>刪除</button>
                    </div>
                  </td>
                </tr>
              ))}
              {jobTypes.length === 0 && <tr><td colSpan={4}><div class="empty-state">尚無職務類型。</div></td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
