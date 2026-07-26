import { useEffect, useMemo, useState } from "preact/hooks";
import { api, jsonBody } from "../api";
import { exportCsv } from "../download";
import type { SheetRow } from "../export";
import type { Employee, ImportSummary, JobTypeOption } from "../types";

// ---- 員工管理（規格 §七 Admin 導覽、§九 CSV 匯入）----
// 對應後端 `/api/admin/employees`（GET/POST/PATCH）與 `/api/admin/employees/import`（見 src/server/m1.ts）。
// 職務類型下拉選項借用既有 `/api/admin/training-matrix` 回傳的 jobTypes（id/name），
// 避免另外要求後端新增一支「職務類型清單」API。

const STATUS_LABEL: Record<string, string> = { active: "在職", inactive: "離職" };
const EMPLOYEE_CSV_TEMPLATE_HEADERS = ["員工編號", "姓名", "Email", "部門", "職等", "職稱", "職務類型", "到職日", "薪資"];

const todayDate = () => new Date().toISOString().slice(0, 10);
const salaryFormatter = new Intl.NumberFormat("zh-TW");

function Message({ text, error = false }: { text: string; error?: boolean }) {
  if (!text) return null;
  return <div class={`alert ${error ? "error" : "success"}`}>{text}</div>;
}

function formatSalary(value: number | null | undefined, visible: boolean): string {
  if (value === null || value === undefined) return "—";
  return visible ? salaryFormatter.format(value) : "＊＊＊＊＊＊";
}

// 目前後端 GET /api/admin/employees 尚未回傳 status 欄位（仍是舊版 activeEmployees 形狀，
// 只回傳在職員工），保守起見缺漏時當作在職，避免「標記離職」按鈕整批消失、
// 全部誤顯示成「恢復在職」。等後端補齊欄位後這裡會自然吃到真實值。
function effectiveStatus(employee: Employee): string {
  return employee.status ?? "active";
}

interface EmployeeForm {
  employeeNo: string;
  name: string;
  email: string;
  department: string;
  grade: string;
  title: string;
  jobTypeId: string;
  hireDate: string;
  salary: string;
}

function emptyForm(): EmployeeForm {
  return {
    employeeNo: "", name: "", email: "", department: "", grade: "", title: "",
    jobTypeId: "", hireDate: todayDate(), salary: "",
  };
}

export function EmployeeManagementPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [jobTypes, setJobTypes] = useState<JobTypeOption[]>([]);
  const [filters, setFilters] = useState({ department: "", grade: "", status: "" });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<EmployeeForm>(emptyForm());
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [salaryVisible, setSalaryVisible] = useState(false);
  const [terminating, setTerminating] = useState<Employee | null>(null);
  const [terminationDate, setTerminationDate] = useState(todayDate());
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importResult, setImportResult] = useState<ImportSummary | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");

  async function load() {
    try {
      const [employeeData, matrixData] = await Promise.all([
        api<{ employees: Employee[] }>("/api/admin/employees?includeInactive=true"),
        api<{ jobTypes: JobTypeOption[] }>("/api/admin/training-matrix"),
      ]);
      setEmployees(employeeData.employees);
      setJobTypes(matrixData.jobTypes);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "讀取員工資料失敗。");
    }
  }
  useEffect(() => { void load(); }, []);

  const departmentOptions = useMemo(
    () => Array.from(new Set(employees.map((item) => item.department).filter(Boolean))).sort(),
    [employees],
  );
  const gradeOptions = useMemo(
    () => Array.from(new Set(employees.map((item) => item.grade).filter(Boolean))).sort(),
    [employees],
  );
  const filteredEmployees = useMemo(() => employees.filter((item) => (
    (filters.department === "" || item.department === filters.department)
    && (filters.grade === "" || item.grade === filters.grade)
    && (filters.status === "" || effectiveStatus(item) === filters.status)
  )), [employees, filters]);

  async function save(event: Event) {
    event.preventDefault();
    setError("");
    setMessage("");
    // 後端 PATCH 全量取代、省略 status 一律視為在職（見 src/server/m1.ts 的 parseEmployee）。
    // 編輯既有員工時必須把目前的在職狀態／離職日一併帶回去，否則單純改個姓名
    // 就會把已離職員工的狀態悄悄改回在職。
    const current = editingId ? employees.find((item) => item.id === editingId) : null;
    const payload = {
      employeeNo: form.employeeNo,
      name: form.name,
      email: form.email,
      department: form.department,
      grade: form.grade,
      title: form.title,
      jobTypeId: form.jobTypeId,
      hireDate: form.hireDate,
      salary: form.salary === "" ? null : Number(form.salary),
      ...(current ? { status: current.status, terminationDate: current.terminationDate } : {}),
    };
    try {
      await api(editingId ? `/api/admin/employees/${editingId}` : "/api/admin/employees", {
        method: editingId ? "PATCH" : "POST",
        ...jsonBody(payload),
      });
      setMessage(editingId ? "員工資料已更新。" : "員工已建立。");
      setEditingId(null);
      setForm(emptyForm());
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "儲存失敗，請確認欄位內容。");
    }
  }

  function edit(employee: Employee) {
    setEditingId(employee.id);
    setForm({
      employeeNo: employee.employeeNo,
      name: employee.name,
      email: employee.email,
      department: employee.department,
      grade: employee.grade,
      title: employee.title,
      jobTypeId: employee.jobTypeId || (jobTypes.find((item) => item.name === employee.jobType)?.id ?? ""),
      hireDate: employee.hireDate,
      salary: employee.salary === null || employee.salary === undefined ? "" : String(employee.salary),
    });
    setMessage("");
    setError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(emptyForm());
  }

  // 後端 PATCH 採全量取代（非局部合併，見 src/server/m1.ts 的 parseEmployee），
  // 標記離職／恢復在職雖然概念上只改一兩個欄位，仍必須連同其餘必填欄位一併送出，
  // 否則會被當成缺漏必填欄位打回 422。
  function employeeBasePayload(employee: Employee) {
    return {
      employeeNo: employee.employeeNo,
      name: employee.name,
      email: employee.email,
      department: employee.department,
      grade: employee.grade,
      title: employee.title,
      jobTypeId: employee.jobTypeId || (jobTypes.find((item) => item.name === employee.jobType)?.id ?? ""),
      hireDate: employee.hireDate,
      salary: employee.salary,
    };
  }

  async function confirmTermination(event: Event) {
    event.preventDefault();
    if (!terminating) return;
    setError("");
    setMessage("");
    try {
      await api(`/api/admin/employees/${terminating.id}`, {
        method: "PATCH",
        ...jsonBody({ ...employeeBasePayload(terminating), status: "inactive", terminationDate }),
      });
      setMessage(`已將「${terminating.name}」標記為離職。`);
      setTerminating(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "標記離職失敗。");
    }
  }

  async function reactivate(employee: Employee) {
    if (!confirm(`確定將「${employee.name}」恢復為在職？`)) return;
    setError("");
    setMessage("");
    try {
      await api(`/api/admin/employees/${employee.id}`, {
        method: "PATCH",
        ...jsonBody({ ...employeeBasePayload(employee), status: "active", terminationDate: null }),
      });
      setMessage(`已恢復「${employee.name}」的在職狀態。`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "更新失敗。");
    }
  }

  function downloadTemplate() {
    const rows: SheetRow[] = [
      EMPLOYEE_CSV_TEMPLATE_HEADERS,
      ["E1001", "王小明", "example@company.com", "人資部", "P3", "資深專員", jobTypes[0]?.name ?? "工程師", "2024-01-01", "60000"],
    ];
    exportCsv("employee-import-template.csv", rows);
  }

  async function runImport() {
    if (!importFile) return;
    setImporting(true);
    setImportError("");
    setImportResult(null);
    try {
      const text = await importFile.text();
      const result = await api<ImportSummary>("/api/admin/employees/import", {
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
          <p class="eyebrow">EMPLOYEE MASTER DATA</p>
          <h1>員工管理</h1>
          <p>維護員工主檔資料，支援手動建檔、編輯、標記離職與 CSV 批次匯入。</p>
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
          在職狀態
          <select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.currentTarget.value })}>
            <option value="">全部</option>
            <option value="active">在職</option>
            <option value="inactive">離職</option>
          </select>
        </label>
      </div>
      <div class="split-layout">
        <form class="panel sticky-form" onSubmit={save}>
          <h2>{editingId ? "編輯員工" : "新增員工"}</h2>
          <label>員工編號<input value={form.employeeNo} onInput={(event) => setForm({ ...form, employeeNo: event.currentTarget.value })} required /></label>
          <label>姓名<input value={form.name} onInput={(event) => setForm({ ...form, name: event.currentTarget.value })} required /></label>
          <label>Email<input type="email" value={form.email} onInput={(event) => setForm({ ...form, email: event.currentTarget.value })} required /></label>
          <label>
            部門
            <input value={form.department} onInput={(event) => setForm({ ...form, department: event.currentTarget.value })} list="employee-department-options" required />
            <datalist id="employee-department-options">{departmentOptions.map((item) => <option value={item} key={item} />)}</datalist>
          </label>
          <label>
            職等
            <input value={form.grade} onInput={(event) => setForm({ ...form, grade: event.currentTarget.value })} list="employee-grade-options" required />
            <datalist id="employee-grade-options">{gradeOptions.map((item) => <option value={item} key={item} />)}</datalist>
          </label>
          <label>職稱<input value={form.title} onInput={(event) => setForm({ ...form, title: event.currentTarget.value })} required /></label>
          <label>
            職務類型
            <select value={form.jobTypeId} onChange={(event) => setForm({ ...form, jobTypeId: event.currentTarget.value })} required>
              <option value="">請選擇</option>
              {jobTypes.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label>到職日<input type="date" value={form.hireDate} onInput={(event) => setForm({ ...form, hireDate: event.currentTarget.value })} required /></label>
          <label>薪資（選填，屬敏感欄位）<input type="number" min="0" value={form.salary} onInput={(event) => setForm({ ...form, salary: event.currentTarget.value })} placeholder="不填則留空" /></label>
          <div class="button-row">
            <button class="primary">{editingId ? "更新" : "建立"}</button>
            {editingId && <button type="button" class="secondary" onClick={cancelEdit}>取消</button>}
          </div>
        </form>
        <div class="table-card">
          <div class="table-toolbar">
            <small>共 {filteredEmployees.length} 筆</small>
            <button type="button" class="secondary" onClick={() => setSalaryVisible((value) => !value)}>
              {salaryVisible ? "隱藏薪資" : "顯示薪資"}
            </button>
          </div>
          <table class="employee-table">
            <thead>
              <tr><th>員工編號</th><th>姓名</th><th>部門／職等</th><th>職稱</th><th>職務類型</th><th>到職日</th><th>狀態</th><th>薪資</th><th /></tr>
            </thead>
            <tbody>
              {filteredEmployees.map((employee) => (
                <tr key={employee.id}>
                  <td>{employee.employeeNo}</td>
                  <td>
                    <strong>{employee.name}</strong>
                    <small>{employee.email}</small>
                  </td>
                  <td>{employee.department}<small>{employee.grade}</small></td>
                  <td>{employee.title}</td>
                  <td>{employee.jobType}</td>
                  <td>
                    {employee.hireDate}
                    {employee.terminationDate && <small>離職 {employee.terminationDate}</small>}
                  </td>
                  <td><span class={`status ${effectiveStatus(employee) === "active" ? "ok" : "danger"}`}>{STATUS_LABEL[effectiveStatus(employee)] ?? effectiveStatus(employee)}</span></td>
                  <td>{formatSalary(employee.salary, salaryVisible)}</td>
                  <td>
                    <div class="row-actions">
                      <button onClick={() => edit(employee)}>編輯</button>
                      {effectiveStatus(employee) === "active"
                        ? <button class="danger-action" onClick={() => { setTerminating(employee); setTerminationDate(todayDate()); }}>標記離職</button>
                        : <button onClick={() => void reactivate(employee)}>恢復在職</button>}
                    </div>
                  </td>
                </tr>
              ))}
              {filteredEmployees.length === 0 && (
                <tr><td colSpan={9}><div class="empty-state">目前沒有符合篩選條件的員工。</div></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div class="panel section-title">
        <div class="panel-heading">
          <div>
            <h2>CSV 批次匯入</h2>
            <small>標題列：員工編號、姓名、Email、部門、職等、職稱、職務類型、到職日、薪資（依員工編號判斷新建或更新）</small>
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

      {terminating && (
        <div class="modal-backdrop" role="presentation">
          <div class="modal" role="dialog" aria-modal="true" aria-label="標記離職">
            <div class="modal-title">
              <div><p class="eyebrow">OFFBOARDING</p><h2>標記「{terminating.name}」離職</h2></div>
              <button class="icon-button" onClick={() => setTerminating(null)}>×</button>
            </div>
            <form onSubmit={confirmTermination}>
              <label>離職日<input type="date" value={terminationDate} onInput={(event) => setTerminationDate(event.currentTarget.value)} required /></label>
              <div class="modal-actions">
                <button type="button" class="secondary" onClick={() => setTerminating(null)}>取消</button>
                <button class="primary">確認離職</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
