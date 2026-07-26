import { useEffect, useMemo, useState } from "preact/hooks";
import { api, jsonBody } from "../api";
import { exportCsv } from "../download";
import type { SheetRow } from "../export";
import type { AttendanceRecord, ImportSummary } from "../types";

// ---- 出缺勤管理（規格 §五 M4：手動輸入 ＋ CSV 匯入）----
// 對應後端 `/api/admin/reports/attendance/records`（GET/POST/PATCH/DELETE）
// 與 `/api/admin/reports/attendance/import`（見 src/server/m4.ts）。
// 員工下拉選項借用既有 `/api/admin/employees` 清單。
//
// 篩選期間與報表中心共用同一套解析邏輯（parseReportFilters）：未指定起訖月份時，
// 後端會依系統設定回溯預設區間並在回應的 filters 帶回實際採用的月份，因此畫面
// 以 resolvedFilters 顯示「目前套用」的月份，避免管理者誤以為看到的是全部歷史紀錄。

const SOURCE_LABEL: Record<string, string> = { manual: "人工登錄", csv: "CSV 匯入" };
const ATTENDANCE_CSV_TEMPLATE_HEADERS = ["員工編號", "日期", "缺勤時數", "加班時數", "假別", "備註"];

const todayDate = () => new Date().toISOString().slice(0, 10);

function Message({ text, error = false }: { text: string; error?: boolean }) {
  if (!text) return null;
  return <div class={`alert ${error ? "error" : "success"}`}>{text}</div>;
}

interface EmployeeOption {
  id: string;
  employeeNo: string;
  name: string;
  department: string;
  grade?: string;
}

interface AttendanceForm {
  employeeId: string;
  attendanceDate: string;
  absenceHours: string;
  overtimeHours: string;
  absenceType: string;
  notes: string;
}

function emptyForm(): AttendanceForm {
  return { employeeId: "", attendanceDate: todayDate(), absenceHours: "0", overtimeHours: "0", absenceType: "", notes: "" };
}

interface FilterState {
  department: string;
  grade: string;
  startMonth: string;
  endMonth: string;
  employeeId: string;
}

function buildQuery(filters: FilterState): string {
  const params = new URLSearchParams();
  if (filters.department) params.set("department", filters.department);
  if (filters.grade) params.set("grade", filters.grade);
  if (filters.startMonth) params.set("startMonth", filters.startMonth);
  if (filters.endMonth) params.set("endMonth", filters.endMonth);
  if (filters.employeeId) params.set("employeeId", filters.employeeId);
  const query = params.toString();
  return query ? `?${query}` : "";
}

interface ResolvedFilters {
  startMonth: string;
  endMonth: string;
}

export function AttendanceManagementPage() {
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [filters, setFilters] = useState<FilterState>({ department: "", grade: "", startMonth: "", endMonth: "", employeeId: "" });
  const [resolvedFilters, setResolvedFilters] = useState<ResolvedFilters | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<AttendanceForm>(emptyForm());
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importResult, setImportResult] = useState<ImportSummary | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");

  useEffect(() => {
    api<{ employees: EmployeeOption[] }>("/api/admin/employees?includeInactive=true")
      .then((data) => setEmployees(data.employees))
      .catch(() => {
        // 員工下拉選單讀取失敗不影響紀錄本體，僅新增表單暫時無法選擇員工。
      });
  }, []);

  async function load() {
    try {
      const data = await api<{ filters: ResolvedFilters; records: AttendanceRecord[] }>(
        `/api/admin/reports/attendance/records${buildQuery(filters)}`,
      );
      setRecords(data.records);
      setResolvedFilters(data.filters);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "讀取出缺勤紀錄失敗。");
    }
  }
  useEffect(() => { void load(); }, [filters.department, filters.grade, filters.startMonth, filters.endMonth, filters.employeeId]);

  const departmentOptions = useMemo(
    () => Array.from(new Set(employees.map((item) => item.department).filter(Boolean))).sort(),
    [employees],
  );
  const gradeOptions = useMemo(
    () => Array.from(new Set(employees.map((item) => item.grade).filter((item): item is string => Boolean(item)))).sort(),
    [employees],
  );

  async function save(event: Event) {
    event.preventDefault();
    setError("");
    setMessage("");
    const payload = {
      employeeId: form.employeeId,
      attendanceDate: form.attendanceDate,
      absenceHours: Number(form.absenceHours || 0),
      overtimeHours: Number(form.overtimeHours || 0),
      absenceType: form.absenceType.trim() === "" ? null : form.absenceType.trim(),
      notes: form.notes,
    };
    try {
      await api(editingId ? `/api/admin/reports/attendance/records/${editingId}` : "/api/admin/reports/attendance/records", {
        method: editingId ? "PATCH" : "POST",
        ...jsonBody(payload),
      });
      setMessage(editingId ? "紀錄已更新。" : "紀錄已儲存（若同員工同日期已有紀錄則覆寫更新）。");
      setEditingId(null);
      setForm(emptyForm());
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "儲存失敗，請確認欄位內容。");
    }
  }

  function edit(record: AttendanceRecord) {
    setEditingId(record.id);
    setForm({
      employeeId: record.employeeId,
      attendanceDate: record.attendanceDate,
      absenceHours: String(record.absenceHours),
      overtimeHours: String(record.overtimeHours),
      absenceType: record.absenceType ?? "",
      notes: record.notes,
    });
    setMessage("");
    setError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(emptyForm());
  }

  async function remove(id: string) {
    if (!confirm("確定刪除此筆出缺勤紀錄？此動作無法復原。")) return;
    setError("");
    setMessage("");
    try {
      await api(`/api/admin/reports/attendance/records/${id}`, { method: "DELETE" });
      setMessage("紀錄已刪除。");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "刪除失敗。");
    }
  }

  function downloadTemplate() {
    const rows: SheetRow[] = [
      ATTENDANCE_CSV_TEMPLATE_HEADERS,
      [employees[0]?.employeeNo ?? "E1001", todayDate(), "8", "0", "事假", "範例列，請替換為實際資料"],
    ];
    exportCsv("attendance-import-template.csv", rows);
  }

  async function runImport() {
    if (!importFile) return;
    setImporting(true);
    setImportError("");
    setImportResult(null);
    try {
      const text = await importFile.text();
      const result = await api<ImportSummary>("/api/admin/reports/attendance/import", {
        method: "POST",
        ...jsonBody({ csv: text }),
      });
      setImportResult(result);
      setImportFile(null);
      await load();
    } catch (caught) {
      setImportError(caught instanceof Error ? caught.message : "匯入失敗，請確認檔案格式後重試。");
    } finally {
      setImporting(false);
    }
  }

  return (
    <section>
      <div class="page-heading">
        <div>
          <p class="eyebrow">ATTENDANCE MANAGEMENT</p>
          <h1>出缺勤管理</h1>
          <p>維護缺勤與加班紀錄，支援手動登錄、編輯、刪除與 CSV 批次匯入。</p>
        </div>
      </div>
      <Message text={message} />
      <Message text={error} error />
      <div class="report-filter-bar">
        <label>
          部門
          <select value={filters.department} onChange={(event) => setFilters({ ...filters, department: event.currentTarget.value })}>
            <option value="">全部部門</option>
            {departmentOptions.map((item) => <option value={item} key={item}>{item}</option>)}
          </select>
        </label>
        <label>
          職等
          <select value={filters.grade} onChange={(event) => setFilters({ ...filters, grade: event.currentTarget.value })}>
            <option value="">全部職等</option>
            {gradeOptions.map((item) => <option value={item} key={item}>{item}</option>)}
          </select>
        </label>
        <label>
          員工
          <select value={filters.employeeId} onChange={(event) => setFilters({ ...filters, employeeId: event.currentTarget.value })}>
            <option value="">全部員工</option>
            {employees.map((item) => <option value={item.id} key={item.id}>{item.employeeNo}・{item.name}</option>)}
          </select>
        </label>
        <label>
          起始月份
          <input
            type="month"
            value={filters.startMonth || resolvedFilters?.startMonth || ""}
            onInput={(event) => setFilters({ ...filters, startMonth: event.currentTarget.value })}
          />
        </label>
        <label>
          結束月份
          <input
            type="month"
            value={filters.endMonth || resolvedFilters?.endMonth || ""}
            onInput={(event) => setFilters({ ...filters, endMonth: event.currentTarget.value })}
          />
        </label>
      </div>
      {resolvedFilters && !filters.startMonth && !filters.endMonth && (
        <p class="muted-copy">未指定月份時，預設顯示 {resolvedFilters.startMonth} ～ {resolvedFilters.endMonth} 的紀錄。</p>
      )}
      <div class="split-layout">
        <form class="panel sticky-form" onSubmit={save}>
          <h2>{editingId ? "編輯出缺勤紀錄" : "新增出缺勤紀錄"}</h2>
          <label>
            員工
            <select value={form.employeeId} onChange={(event) => setForm({ ...form, employeeId: event.currentTarget.value })} required>
              <option value="">請選擇員工</option>
              {employees.map((item) => <option value={item.id} key={item.id}>{item.employeeNo}・{item.name}（{item.department}）</option>)}
            </select>
          </label>
          <label>日期<input type="date" value={form.attendanceDate} onInput={(event) => setForm({ ...form, attendanceDate: event.currentTarget.value })} required /></label>
          <div class="form-grid">
            <label>缺勤時數<input type="number" min="0" step="0.5" value={form.absenceHours} onInput={(event) => setForm({ ...form, absenceHours: event.currentTarget.value })} /></label>
            <label>加班時數<input type="number" min="0" step="0.5" value={form.overtimeHours} onInput={(event) => setForm({ ...form, overtimeHours: event.currentTarget.value })} /></label>
          </div>
          <label>假別（選填）<input value={form.absenceType} onInput={(event) => setForm({ ...form, absenceType: event.currentTarget.value })} placeholder="例：事假、病假、特休" /></label>
          <label>備註<textarea value={form.notes} onInput={(event) => setForm({ ...form, notes: event.currentTarget.value })} /></label>
          <div class="button-row">
            <button class="primary">{editingId ? "更新" : "新增"}</button>
            {editingId && <button type="button" class="secondary" onClick={cancelEdit}>取消</button>}
          </div>
        </form>
        <div class="table-card">
          <table class="attendance-record-table">
            <thead>
              <tr><th>日期</th><th>員工</th><th>部門</th><th>缺勤時數</th><th>加班時數</th><th>假別</th><th>備註</th><th>來源</th><th /></tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id}>
                  <td>{record.attendanceDate}</td>
                  <td><strong>{record.employeeName}</strong><small>{record.employeeNo}</small></td>
                  <td>{record.department}</td>
                  <td>{record.absenceHours}</td>
                  <td>{record.overtimeHours}</td>
                  <td>{record.absenceType ?? "—"}</td>
                  <td><small>{record.notes}</small></td>
                  <td><span class="status">{SOURCE_LABEL[record.source] ?? record.source}</span></td>
                  <td>
                    <div class="row-actions">
                      <button onClick={() => edit(record)}>編輯</button>
                      <button class="danger-action" onClick={() => void remove(record.id)}>刪除</button>
                    </div>
                  </td>
                </tr>
              ))}
              {records.length === 0 && (
                <tr><td colSpan={9}><div class="empty-state">期間內查無出缺勤紀錄。</div></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div class="panel section-title">
        <div class="panel-heading">
          <div>
            <h2>CSV 批次匯入</h2>
            <small>標題列：員工編號、日期、缺勤時數、加班時數、假別、備註（同員工同日期採更新覆寫）</small>
          </div>
          <button type="button" class="secondary" onClick={downloadTemplate}>下載範本 CSV</button>
        </div>
        <div class="button-row">
          <input type="file" accept=".csv,text/csv" onChange={(event) => setImportFile(event.currentTarget.files?.[0] ?? null)} />
          <button class="primary" disabled={!importFile || importing} onClick={() => void runImport()}>
            {importing ? "匯入中…" : "開始匯入"}
          </button>
        </div>
        <Message text={importError} error />
        {importResult && (
          <div>
            <div class="metric-row">
              <div class="metric"><span>新增</span><strong>{importResult.imported}</strong></div>
              <div class="metric"><span>更新</span><strong>{importResult.updated}</strong></div>
              <div class="metric"><span>略過</span><strong>{importResult.skipped}</strong></div>
              <div class={`metric ${importResult.errors.length > 0 ? "accent" : ""}`}><span>錯誤筆數</span><strong>{importResult.errors.length}</strong></div>
            </div>
            {importResult.errors.length > 0 && (
              <div class="table-card">
                <table>
                  <thead><tr><th>行號</th><th>錯誤訊息</th></tr></thead>
                  <tbody>
                    {importResult.errors.map((item, index) => (
                      <tr key={`${item.row}-${index}`}><td>第 {item.row} 行</td><td>{item.message}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {importResult.errors.length === 0 && <Message text="匯入完成，所有列皆處理成功。" />}
          </div>
        )}
      </div>
    </section>
  );
}
