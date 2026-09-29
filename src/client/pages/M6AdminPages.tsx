import { useEffect, useState } from "preact/hooks";
import { api, jsonBody } from "../api";
import {
  HEALTH_STATUS_CLASS,
  HEALTH_STATUS_FALLBACK_LABEL,
  HEALTH_STATUS_ROW_CLASS,
  RESULT_FALLBACK_LABEL,
  RESULT_OPTIONS,
  intervalReasonText,
  monthsUntilDueText,
} from "../components/HealthCheckHelpers";
import { Field, FieldHelp } from "../components/FieldHelp";
import { CertificationsPage } from "./M2AdminPages";
import type {
  HealthCheckDueEntry,
  HealthCheckDueListPayload,
  HealthCheckItem,
  HealthCheckRecord,
  HealthCheckResultValue,
} from "../types";

// ---- M6：健康與證照（規格：把健檢追蹤併入既有「證照管理」分頁並改名）----
// 對應後端 src/server/health.ts（base /api/admin/health-check-items、
// /api/admin/health-checks、/api/admin/health-checks/due）。欄位已對照後端
// 實際回傳鍵名核對，非猜測。
//
// 健檢紀錄屬個資法第 6 條特種個資，清單頁比照既有薪資欄位的處理方式——
// 項目與逐項結果、備註預設隱藏，需手動按「顯示項目明細」才會攤開。

function Message({ text, error = false }: { text: string; error?: boolean }) {
  if (!text) return null;
  return <div class={`alert ${error ? "error" : "success"}`}>{text}</div>;
}

type HealthSection = "due" | "records" | "items" | "certifications";

export function HealthAndCertificationsPage({ initialSection = "due" }: {
  initialSection?: HealthSection;
} = {}) {
  const [section, setSection] = useState<HealthSection>(initialSection);
  const sections: Array<{ id: HealthSection; label: string }> = [
    { id: "due", label: "待健檢名單" },
    { id: "records", label: "健檢紀錄" },
    { id: "items", label: "健檢項目主檔" },
    { id: "certifications", label: "證照管理" },
  ];
  return (
    <>
      <div class="page-heading">
        <div>
          <p class="eyebrow">HEALTH &amp; CERTIFICATIONS</p>
          <h1>健康與證照</h1>
          <p>員工健檢追蹤與到期提醒，以及既有的證照管理。</p>
        </div>
      </div>
      <div class="talent-nav" role="tablist" aria-label="健康與證照分頁">
        {sections.map((item) => (
          <button class={section === item.id ? "active" : ""} onClick={() => setSection(item.id)} role="tab" aria-selected={section === item.id} key={item.id}>
            {item.label}
          </button>
        ))}
      </div>
      {section === "due" && <HealthCheckDuePage />}
      {section === "records" && <HealthCheckRecordsPage />}
      {section === "items" && <HealthCheckItemsPage />}
      {section === "certifications" && <CertificationsPage />}
    </>
  );
}

function dueRowNote(entry: HealthCheckDueEntry): string {
  if (entry.status === "missing_birth_date") return "請於員工管理頁補登出生日期";
  if (entry.dueBasis === "hire_date") return "以到職日推算（尚無健檢紀錄）";
  return "";
}

function HealthCheckDuePage() {
  const [months, setMonths] = useState<number | null>(null);
  const [payload, setPayload] = useState<HealthCheckDueListPayload | null>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  // 不帶 months 查詢字串時，後端以 reminderMonths（系統設定：健康檢查到期提前
  // 提醒月數）當作預設篩選視窗，回應內的 windowMonths 即為當下生效值——不需要
  // 前端另外猜測或重複讀取設定 API。
  async function load(explicitMonths?: number) {
    setError("");
    try {
      const query = explicitMonths === undefined ? "" : `?months=${explicitMonths}`;
      const data = await api<HealthCheckDueListPayload>(`/api/admin/health-checks/due${query}`);
      setPayload(data);
      setMonths(data.windowMonths);
    } catch (caught) {
      setPayload(null);
      setError(caught instanceof Error ? caught.message : "讀取失敗。");
    } finally {
      setLoaded(true);
    }
  }
  useEffect(() => { void load(); }, []);

  const entries = payload?.employees ?? [];
  const counts = {
    overdue: entries.filter((entry) => entry.status === "overdue").length,
    due_soon: entries.filter((entry) => entry.status === "due_soon").length,
    ok: entries.filter((entry) => entry.status === "ok").length,
    never: entries.filter((entry) => entry.status === "never").length,
    missing_birth_date: entries.filter((entry) => entry.status === "missing_birth_date").length,
  };

  return (
    <section>
      <div class="page-heading">
        <div>
          <p class="eyebrow">DUE FOR CHECKUP</p><h1>待健檢名單</h1>
          <p>依急迫度排序，逾期者最優先處理。{payload && <>目前到期提醒門檻為提前 {payload.reminderMonths} 個月（可在「系統設定」調整）。</>}</p>
        </div>
        <Field
          className="compact-label"
          label="未來幾個月內到期"
          help={<>只是這份清單的<strong>檢視範圍</strong>，改它不會影響任何提醒設定。
            想調整實際的提醒時機請到「系統設定 → 健康檢查到期提前提醒月數」。</>}
        >
          <input
            type="number"
            min="1"
            max="600"
            value={months ?? ""}
            disabled={!loaded}
            onChange={(event) => {
              const value = Math.max(1, Math.min(600, Number(event.currentTarget.value) || 1));
              void load(value);
            }}
          />
        </Field>
      </div>
      <Message text={error} error />
      <div class="matrix-legend">
        <span><i class="red" /> 已逾期（{counts.overdue}）</span>
        <span><i class="yellow" /> 即將到期（{counts.due_soon}）</span>
        <span><i class="green" /> 尚未到期（{counts.ok}）</span>
        <span><i class="never" /> 從未健檢（{counts.never}）</span>
        <span><i class="na" /> 缺生日資料（{counts.missing_birth_date}）</span>
      </div>
      <div class="table-card">
        <table class="mandatory-table">
          <thead><tr><th>員工</th><th>出生日期／年齡</th><th>健檢頻率</th><th>上次健檢</th><th>下次應檢日</th><th>距今</th><th>狀態</th></tr></thead>
          <tbody>
            {entries.map((entry) => (
              <tr class={HEALTH_STATUS_ROW_CLASS[entry.status]} key={entry.employeeId}>
                <td><strong>{entry.name}</strong><small>{entry.employeeNo}・{entry.department}</small></td>
                <td>{entry.birthDate ?? "未登記"}<small>{entry.age !== null ? `${entry.age} 歲` : "年齡未知"}</small></td>
                <td>{intervalReasonText(entry.age)}</td>
                <td>{entry.lastCheckDate ?? "從未健檢"}</td>
                <td>{entry.nextDueDate ?? "—"}<small>{dueRowNote(entry)}</small></td>
                <td>{monthsUntilDueText(entry.monthsUntilDue)}</td>
                <td><span class={HEALTH_STATUS_CLASS[entry.status]}>{entry.statusLabel || HEALTH_STATUS_FALLBACK_LABEL[entry.status]}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {loaded && entries.length === 0 && !error && <div class="empty-state">目前沒有符合條件的待健檢人員。</div>}
      </div>
    </section>
  );
}

interface EmployeeOption {
  id: string;
  employeeNo: string;
  name: string;
  department: string;
}

interface ItemSelection {
  checked: boolean;
  result: HealthCheckResultValue;
  notes: string;
}

function buildSelection(items: HealthCheckItem[], record?: HealthCheckRecord): Record<string, ItemSelection> {
  const selection: Record<string, ItemSelection> = {};
  for (const item of items) selection[item.id] = { checked: false, result: "pending", notes: "" };
  if (record) {
    for (const resultItem of record.items) {
      selection[resultItem.itemId] = { checked: true, result: resultItem.result, notes: resultItem.notes };
    }
  }
  return selection;
}

function todayDate() { return new Date().toISOString().slice(0, 10); }

function HealthCheckRecordsPage() {
  const emptyForm = { employeeId: "", checkDate: todayDate(), institution: "", notes: "" };
  const [records, setRecords] = useState<HealthCheckRecord[]>([]);
  const [items, setItems] = useState<HealthCheckItem[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [filterEmployeeId, setFilterEmployeeId] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [selection, setSelection] = useState<Record<string, ItemSelection>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [detailsVisible, setDetailsVisible] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load() {
    setError("");
    try {
      const query = filterEmployeeId ? `?employeeId=${encodeURIComponent(filterEmployeeId)}` : "";
      const [recordData, itemData, employeeData] = await Promise.all([
        api<{ healthChecks: HealthCheckRecord[] }>(`/api/admin/health-checks${query}`),
        api<{ items: HealthCheckItem[] }>("/api/admin/health-check-items"),
        api<{ employees: EmployeeOption[] }>("/api/admin/employees"),
      ]);
      setRecords(recordData.healthChecks);
      setItems(itemData.items);
      setEmployees(employeeData.employees);
      setForm((current) => ({ ...current, employeeId: current.employeeId || employeeData.employees[0]?.id || "" }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "讀取失敗。");
    }
  }
  useEffect(() => { void load(); }, [filterEmployeeId]);

  function updateSelection(itemId: string, patch: Partial<ItemSelection>) {
    setSelection((current) => ({ ...current, [itemId]: { ...(current[itemId] ?? { checked: false, result: "pending", notes: "" }), ...patch } }));
  }

  function resetForm() {
    setEditingId(null);
    setForm({ ...emptyForm, employeeId: employees[0]?.id ?? "" });
    setSelection(buildSelection(items));
  }

  async function save(event: Event) {
    event.preventDefault();
    setError(""); setMessage("");
    const chosenItems = Object.entries(selection)
      .filter(([, value]) => value.checked)
      .map(([itemId, value]) => ({ itemId, result: value.result, notes: value.notes }));
    if (chosenItems.length === 0) { setError("請至少勾選一項健檢項目。"); return; }
    try {
      await api(editingId ? `/api/admin/health-checks/${editingId}` : "/api/admin/health-checks", {
        method: editingId ? "PATCH" : "POST",
        ...jsonBody({ ...form, items: chosenItems }),
      });
      setMessage(editingId ? "健檢紀錄已更新。" : "健檢紀錄已新增。");
      resetForm();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "儲存失敗。");
    }
  }

  function editRecord(record: HealthCheckRecord) {
    setEditingId(record.id);
    setForm({ employeeId: record.employeeId, checkDate: record.checkDate, institution: record.institution, notes: record.notes });
    setSelection(buildSelection(items, record));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function removeRecord(id: string) {
    if (!confirm("確定刪除此筆健檢紀錄？")) return;
    setError(""); setMessage("");
    try {
      await api(`/api/admin/health-checks/${id}`, { method: "DELETE" });
      setMessage("健檢紀錄已刪除。");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "刪除失敗。");
    }
  }

  return (
    <section>
      <div class="page-heading">
        <div><p class="eyebrow">HEALTH CHECK RECORDS</p><h1>健檢紀錄</h1><p>登錄每次健檢的日期、機構與勾選項目；下次應檢日於「待健檢名單」依年齡分級自動推算。</p></div>
        <label class="compact-label">篩選員工
          <select value={filterEmployeeId} onChange={(event) => setFilterEmployeeId(event.currentTarget.value)}>
            <option value="">全部員工</option>
            {employees.map((employee) => <option value={employee.id}>{employee.employeeNo}・{employee.name}</option>)}
          </select>
        </label>
      </div>
      <Message text={message} /><Message text={error} error />
      <div class="split-layout">
        <form class="panel sticky-form" onSubmit={save}>
          <h2>{editingId ? "編輯健檢紀錄" : "新增健檢紀錄"}</h2>
          <label>員工<select value={form.employeeId} onChange={(event) => setForm({ ...form, employeeId: event.currentTarget.value })}>
            {employees.map((employee) => <option value={employee.id}>{employee.employeeNo}・{employee.name}</option>)}
          </select></label>
          <div class="form-grid">
            <Field
              label="健檢日期"
              help={<>實際受檢日，<strong>下次應檢日以此為基準推算</strong>。填錯會讓提醒時機整個位移。
                從未健檢的員工則改以到職日推算。</>}
            ><input type="date" value={form.checkDate} onInput={(event) => setForm({ ...form, checkDate: event.currentTarget.value })} required /></Field>
            <Field
              label="檢查機構"
              help={<>受檢的醫院或診所名稱，供日後查詢與核對報告用。不影響任何計算，可留空。</>}
            ><input value={form.institution} onInput={(event) => setForm({ ...form, institution: event.currentTarget.value })} placeholder="選填" /></Field>
          </div>
          <div>
            <span class="compact-label">本次健檢項目與結果</span>
            <div class="health-item-list">
              {items.map((item) => {
                const current = selection[item.id] ?? { checked: false, result: "pending" as HealthCheckResultValue, notes: "" };
                return (
                  <div class={`health-item-row ${item.active ? "" : "inactive"}`} key={item.id}>
                    <label class="inline-check">
                      <input type="checkbox" checked={current.checked} onChange={(event) => updateSelection(item.id, { checked: event.currentTarget.checked })} />
                      {item.name}{item.category && <small> ・{item.category}</small>}{item.required === 1 && <em> 必檢</em>}
                    </label>
                    {current.checked && (
                      <div class="health-item-detail">
                        <select value={current.result} onChange={(event) => updateSelection(item.id, { result: event.currentTarget.value as HealthCheckResultValue })}>
                          {RESULT_OPTIONS.map((value) => <option value={value}>{RESULT_FALLBACK_LABEL[value]}</option>)}
                        </select>
                        <input value={current.notes} onInput={(event) => updateSelection(item.id, { notes: event.currentTarget.value })} placeholder="項目備註（選填）" />
                      </div>
                    )}
                  </div>
                );
              })}
              {items.length === 0 && <small>尚未建立健檢項目，請先於「健檢項目主檔」新增。</small>}
            </div>
          </div>
          <label>整體備註<textarea value={form.notes} onInput={(event) => setForm({ ...form, notes: event.currentTarget.value })} placeholder="屬敏感資料，僅授權人員可見" /></label>
          <div class="button-row"><button class="primary">{editingId ? "更新" : "新增"}</button>{editingId && <button type="button" class="secondary" onClick={resetForm}>取消</button>}</div>
        </form>
        <div class="table-card">
          <div class="table-toolbar">
            <strong>健檢紀錄清單</strong>
            <button type="button" class="secondary" onClick={() => setDetailsVisible((value) => !value)}>
              {detailsVisible ? "隱藏項目明細" : "顯示項目明細"}
            </button>
          </div>
          <table>
            <thead><tr><th>員工</th><th>健檢日期</th><th>機構</th><th>項目／備註</th><th /></tr></thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id}>
                  <td><strong>{record.employeeName}</strong><small>{record.employeeNo}・{record.department}</small></td>
                  <td>{record.checkDate}</td>
                  <td>{record.institution || "—"}</td>
                  <td>
                    {detailsVisible
                      ? <>
                          <div class="chip-list">{record.items.map((item) => <span class={item.result === "abnormal" ? "result-abnormal" : item.result === "follow_up" ? "result-follow-up" : ""} key={item.id}>{item.itemName}・{item.resultLabel}{item.notes ? `（${item.notes}）` : ""}</span>)}</div>
                          {record.notes && <small>整體備註：{record.notes}</small>}
                        </>
                      : <small>已隱藏（{record.items.length} 項{record.notes || record.items.some((item) => item.notes) ? "・含備註" : ""}）</small>}
                  </td>
                  <td><div class="row-actions"><button onClick={() => editRecord(record)}>編輯</button><button class="danger-action" onClick={() => void removeRecord(record.id)}>刪除</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
          {records.length === 0 && <div class="empty-state">目前沒有健檢紀錄。</div>}
        </div>
      </div>
    </section>
  );
}

function HealthCheckItemsPage() {
  const emptyForm = { name: "", category: "", required: true, active: true, sortOrder: 0 };
  const [items, setItems] = useState<HealthCheckItem[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load() {
    setError("");
    try {
      const data = await api<{ items: HealthCheckItem[] }>("/api/admin/health-check-items");
      setItems(data.items);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "讀取失敗。");
    }
  }
  useEffect(() => { void load(); }, []);

  async function save(event: Event) {
    event.preventDefault();
    setError(""); setMessage("");
    try {
      await api(editingId ? `/api/admin/health-check-items/${editingId}` : "/api/admin/health-check-items", {
        method: editingId ? "PATCH" : "POST",
        ...jsonBody(form),
      });
      setMessage(editingId ? "健檢項目已更新。" : "健檢項目已新增。");
      setEditingId(null); setForm(emptyForm); await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "儲存失敗。");
    }
  }

  function edit(item: HealthCheckItem) {
    setEditingId(item.id);
    setForm({ name: item.name, category: item.category, required: item.required === 1, active: item.active === 1, sortOrder: item.sortOrder });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function remove(item: HealthCheckItem) {
    if (!confirm(`確定刪除健檢項目「${item.name}」？`)) return;
    setError(""); setMessage("");
    try {
      const result = await api<{ id: string; deleted: boolean; archived: boolean; message?: string }>(
        `/api/admin/health-check-items/${item.id}`,
        { method: "DELETE" },
      );
      setMessage(result.message ?? (result.deleted ? "健檢項目已刪除。" : "健檢項目已停用。"));
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "刪除失敗。");
    }
  }

  return (
    <section>
      <div class="page-heading"><div><p class="eyebrow">HEALTH CHECK ITEMS</p><h1>健檢項目主檔</h1><p>維護可勾選的健檢項目，例如血液檢查、X 光、心電圖等。已被健檢紀錄使用者刪除時會自動改為停用。</p></div></div>
      <Message text={message} /><Message text={error} error />
      <div class="split-layout">
        <form class="panel sticky-form" onSubmit={save}>
          <h2>{editingId ? "編輯健檢項目" : "新增健檢項目"}</h2>
          <label>名稱<input value={form.name} onInput={(event) => setForm({ ...form, name: event.currentTarget.value })} required /></label>
          <div class="form-grid">
            <label>分類（選填）<input value={form.category} onInput={(event) => setForm({ ...form, category: event.currentTarget.value })} placeholder="例如：血液生化" /></label>
            <Field
              label="排序"
              help={<>數字小的排前面，決定登錄健檢時項目的顯示順序。相同數字則依名稱排列。</>}
            ><input type="number" min="0" max="9999" value={form.sortOrder} onInput={(event) => setForm({ ...form, sortOrder: Number(event.currentTarget.value) })} /></Field>
          </div>
          <div class="field">
            <label class="inline-check"><input type="checkbox" checked={form.required} onChange={(event) => setForm({ ...form, required: event.currentTarget.checked })} /> 必檢項目</label>
            <FieldHelp label="必檢項目">在登錄健檢結果時會標示為「必檢」，提醒登錄者不要漏掉。
              用於法規要求的項目。</FieldHelp>
          </div>
          <div class="field">
            <label class="inline-check"><input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.currentTarget.checked })} /> 啟用</label>
            <FieldHelp label="啟用">停用後不再出現在新的健檢登錄選項中，但<strong>既有紀錄裡的這個項目
              完整保留</strong>。項目改版時請停用舊的、新增新的，不要直接改名——改名會讓歷史紀錄
              看起來像是當年就檢查了新項目。</FieldHelp>
          </div>
          <div class="button-row"><button class="primary">{editingId ? "更新" : "新增"}</button>{editingId && <button type="button" class="secondary" onClick={() => { setEditingId(null); setForm(emptyForm); }}>取消</button>}</div>
        </form>
        <div class="table-card">
          <table>
            <thead><tr><th>名稱</th><th>分類</th><th>必檢／選檢</th><th>狀態</th><th /></tr></thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td><strong>{item.name}</strong></td>
                  <td>{item.category || "—"}</td>
                  <td>{item.required ? "必檢" : "選檢"}</td>
                  <td><span class={`status ${item.active ? "ok" : "muted"}`}>{item.active ? "啟用" : "停用"}</span></td>
                  <td><div class="row-actions"><button onClick={() => edit(item)}>編輯</button><button class="danger-action" onClick={() => void remove(item)}>刪除</button></div></td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={5}><div class="empty-state">尚無健檢項目。</div></td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
