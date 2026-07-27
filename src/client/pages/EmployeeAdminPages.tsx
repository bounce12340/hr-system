import { useEffect, useMemo, useState } from "preact/hooks";
import { api, jsonBody } from "../api";
import { exportCsv } from "../download";
import type { SheetRow } from "../export";
import type {
  AdminUserAccount,
  Employee,
  EmployeeResponsibility,
  ImportSummary,
  JobTypeOption,
  Role,
} from "../types";

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

// ---- 登入帳號生命週期管理 ----
// 對應後端 GET/POST/PATCH/DELETE /api/admin/users 與
// GET /api/admin/employees/{id}/responsibilities（由另一位 agent 同步實作
// 後端，本檔完成時可能尚未就緒）。欄位型別、布林／數字編碼與回應信封的
// 精確形狀，皆以下列函式做防禦性解析，避免後端實際回傳格式與猜測略有出入
// 時整頁面直接壞掉。

const ROLE_LABEL: Record<Role, string> = { admin: "管理者", employee: "一般員工" };

function normalizeAccountRow(raw: unknown): AdminUserAccount {
  const row = (raw ?? {}) as Record<string, unknown>;
  const employeeStatus = row.employeeStatus === "active" || row.employeeStatus === "inactive" ? row.employeeStatus : null;
  return {
    id: String(row.id ?? ""),
    email: String(row.email ?? ""),
    role: row.role === "admin" ? "admin" : "employee",
    active: Boolean(row.active),
    mustChangePassword: Boolean(row.mustChangePassword),
    employeeId: row.employeeId == null ? null : String(row.employeeId),
    employeeName: row.employeeName == null ? null : String(row.employeeName),
    employeeStatus,
    auditRefCount: Number(row.auditRefCount ?? 0),
  };
}

// 建立帳號／重設密碼不再回傳 temporaryPassword，改為 `{ user, mail: { status,
// message }, setupUrl? }`：寄信成功時沒有 setupUrl，前端只顯示「已寄至 xxx」；
// setupUrl 有值代表未設定 app_base_url 或寄信失敗，須顯示連結讓 admin 手動轉達
// （比照原本臨時密碼「只顯示這一次」的處理）。確切是否攤平在頂層或包在
// user/account 之下規格未逐字給定，因此兩種形狀都嘗試解析。
interface SetupOutcome {
  email: string;
  setupUrl: string;
}

function extractSetupOutcome(raw: unknown, fallbackEmail: string): SetupOutcome {
  const row = (raw ?? {}) as Record<string, unknown>;
  const nestedUser = (row.user ?? row.account ?? {}) as Record<string, unknown>;
  const email = typeof row.email === "string" && row.email
    ? row.email
    : typeof nestedUser.email === "string" && nestedUser.email
      ? nestedUser.email
      : fallbackEmail;
  const setupUrl = typeof row.setupUrl === "string" ? row.setupUrl : "";
  return { email, setupUrl };
}

function extractDeleteResult(raw: unknown): { mode: "deleted" | "archived"; auditRefCount: number; message: string } {
  const row = (raw ?? {}) as Record<string, unknown>;
  return {
    mode: row.mode === "archived" ? "archived" : "deleted",
    auditRefCount: Number(row.auditRefCount ?? 0),
    message: typeof row.message === "string" ? row.message : "",
  };
}

// 職責端點回應的確切形狀未逐字給定（可能是單一陣列並標註 relation，也可能
// 分兩個陣列各自代表現任者／繼任者），這裡盡量涵蓋常見形狀後統一成單一清單。
function normalizeResponsibilities(raw: unknown): EmployeeResponsibility[] {
  if (!raw || typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  const buckets: Array<{ item: unknown; forcedRelation?: "incumbent" | "successor" }> = [];
  const direct = record.responsibilities ?? record.items;
  if (Array.isArray(direct)) {
    for (const item of direct) buckets.push({ item });
  }
  const incumbentList = record.incumbentOf ?? record.incumbentPositions;
  if (Array.isArray(incumbentList)) {
    for (const item of incumbentList) buckets.push({ item, forcedRelation: "incumbent" });
  }
  const successorList = record.successorOf ?? record.successorPositions;
  if (Array.isArray(successorList)) {
    for (const item of successorList) buckets.push({ item, forcedRelation: "successor" });
  }
  return buckets.map(({ item, forcedRelation }) => {
    const row = (item ?? {}) as Record<string, unknown>;
    const relationRaw = String(row.relation ?? row.role ?? row.type ?? "").toLowerCase();
    return {
      keyPositionId: String(row.keyPositionId ?? row.id ?? ""),
      keyPositionTitle: String(row.keyPositionTitle ?? row.title ?? row.positionTitle ?? ""),
      department: String(row.department ?? ""),
      relation: forcedRelation ?? (relationRaw === "successor" ? "successor" : "incumbent"),
      relationLabel: typeof row.relationLabel === "string" ? row.relationLabel : undefined,
    };
  });
}

function actionErrorMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
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

type AccountModalView = "manage" | "reveal";

interface AccountModalState {
  employee: Employee;
  account: AdminUserAccount | null;
  view: AccountModalView;
  role: Role;
  /** 寄信成功時使用的收件信箱（顯示「設定連結已寄至 xxx」）。 */
  revealEmail: string;
  /** 未設定 app_base_url 或寄信失敗時，後端回傳的一次性連結；空字串代表寄信已成功。 */
  revealSetupUrl: string;
  revealContext: "create" | "reset";
  copied: boolean;
  busy: boolean;
  error: string;
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

  // ---- 登入帳號生命週期管理 ----
  const [accounts, setAccounts] = useState<AdminUserAccount[]>([]);
  const [accountsError, setAccountsError] = useState("");
  const [accountModal, setAccountModal] = useState<AccountModalState | null>(null);
  const [responsibilities, setResponsibilities] = useState<EmployeeResponsibility[] | null>(null);
  const [responsibilitiesLoading, setResponsibilitiesLoading] = useState(false);

  const accountByEmployee = useMemo(
    () => new Map(accounts.filter((account) => account.employeeId).map((account) => [account.employeeId as string, account])),
    [accounts],
  );

  async function loadAccounts() {
    try {
      const data = await api<{ users: unknown[] }>("/api/admin/users");
      setAccounts(data.users.map(normalizeAccountRow));
      setAccountsError("");
    } catch (caught) {
      setAccounts([]);
      setAccountsError(actionErrorMessage(caught, "登入帳號功能目前無法使用。"));
    }
  }

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
    await loadAccounts();
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
      // 後端會在標記離職時一併停用該員工的登入帳號，並回報實際停用的帳號數
      // （見 src/server/m1.ts updateEmployee 呼叫 accounts.ts
      // deactivateAccountsForEmployee），用這個權威數字組訊息，不用本地猜測。
      const result = await api<{ deactivatedAccounts?: number }>(`/api/admin/employees/${terminating.id}`, {
        method: "PATCH",
        ...jsonBody({ ...employeeBasePayload(terminating), status: "inactive", terminationDate }),
      });
      const deactivatedAccounts = result.deactivatedAccounts ?? 0;
      setMessage(`已將「${terminating.name}」標記為離職${deactivatedAccounts > 0 ? "，其登入帳號已一併停用" : ""}。`);
      closeTerminationModal();
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

  // 標記離職會自動停用登入帳號；開啟確認視窗時一併查詢該員工是否持有關鍵
  // 職位的現任者／繼任者身分，離職前提醒 HR 先行移轉（僅提醒，不阻擋操作）。
  async function openTerminationModal(employee: Employee) {
    setTerminating(employee);
    setTerminationDate(todayDate());
    setResponsibilities(null);
    setResponsibilitiesLoading(true);
    try {
      const data = await api<unknown>(`/api/admin/employees/${employee.id}/responsibilities`);
      setResponsibilities(normalizeResponsibilities(data));
    } catch {
      // 讀取職責清單失敗不應阻擋標記離職，僅是少了提醒；保守顯示為「無資料」。
      setResponsibilities([]);
    } finally {
      setResponsibilitiesLoading(false);
    }
  }

  function closeTerminationModal() {
    setTerminating(null);
    setResponsibilities(null);
    setResponsibilitiesLoading(false);
  }

  // ---- 登入帳號生命週期管理 ----

  function openAccountModal(employee: Employee) {
    const account = accountByEmployee.get(employee.id) ?? null;
    setAccountModal({
      employee,
      account,
      view: "manage",
      role: account?.role ?? "employee",
      revealEmail: "",
      revealSetupUrl: "",
      revealContext: "create",
      copied: false,
      busy: false,
      error: "",
    });
  }

  // 一次性密碼只存在這個 state 裡；關閉視窗即整份丟棄，不做任何持久化或
  // 二次讀取途徑，符合「關閉後不可再從任何地方取得」的要求。
  function closeAccountModal() {
    setAccountModal(null);
  }

  async function createAccountForModal() {
    if (!accountModal || accountModal.account) return;
    const { employee, role } = accountModal;
    setAccountModal((current) => (current ? { ...current, busy: true, error: "" } : current));
    try {
      const data = await api<unknown>("/api/admin/users", {
        method: "POST",
        ...jsonBody({ employeeId: employee.id, role }),
      });
      const outcome = extractSetupOutcome(data, employee.email);
      await loadAccounts();
      setAccountModal((current) => (current ? {
        ...current,
        busy: false,
        view: "reveal",
        revealContext: "create",
        revealEmail: outcome.email,
        revealSetupUrl: outcome.setupUrl,
        copied: false,
      } : current));
    } catch (caught) {
      setAccountModal((current) => (current ? { ...current, busy: false, error: actionErrorMessage(caught, "建立帳號失敗。") } : current));
    }
  }

  async function toggleAccountActive() {
    if (!accountModal?.account) return;
    const account = accountModal.account;
    const next = !account.active;
    if (!next && !confirm(`確定停用「${accountModal.employee.name}」的登入帳號？停用後將立即無法登入。`)) return;
    setAccountModal((current) => (current ? { ...current, busy: true, error: "" } : current));
    try {
      await api(`/api/admin/users/${account.id}`, { method: "PATCH", ...jsonBody({ active: next }) });
      await loadAccounts();
      setAccountModal((current) => (current && current.account ? { ...current, busy: false, account: { ...current.account, active: next } } : current));
    } catch (caught) {
      setAccountModal((current) => (current ? { ...current, busy: false, error: actionErrorMessage(caught, "更新帳號狀態失敗。") } : current));
    }
  }

  async function changeAccountRole(role: Role) {
    if (!accountModal?.account) return;
    const accountId = accountModal.account.id;
    setAccountModal((current) => (current ? { ...current, busy: true, error: "", role } : current));
    try {
      await api(`/api/admin/users/${accountId}`, { method: "PATCH", ...jsonBody({ role }) });
      await loadAccounts();
      setAccountModal((current) => (current && current.account ? { ...current, busy: false, account: { ...current.account, role } } : current));
    } catch (caught) {
      setAccountModal((current) => (current ? { ...current, busy: false, error: actionErrorMessage(caught, "變更角色失敗。") } : current));
    }
  }

  async function resetAccountPassword() {
    if (!accountModal?.account) return;
    if (!confirm(`確定要重設「${accountModal.employee.name}」的密碼？原密碼將立即失效。`)) return;
    const accountId = accountModal.account.id;
    setAccountModal((current) => (current ? { ...current, busy: true, error: "" } : current));
    try {
      const data = await api<unknown>(`/api/admin/users/${accountId}/reset-password`, {
        method: "POST",
        ...jsonBody({}),
      });
      const outcome = extractSetupOutcome(data, accountModal.account.email);
      await loadAccounts();
      setAccountModal((current) => (current ? {
        ...current,
        busy: false,
        view: "reveal",
        revealContext: "reset",
        revealEmail: outcome.email,
        revealSetupUrl: outcome.setupUrl,
        copied: false,
      } : current));
    } catch (caught) {
      setAccountModal((current) => (current ? { ...current, busy: false, error: actionErrorMessage(caught, "重設密碼失敗。") } : current));
    }
  }

  async function deleteAccountFromModal() {
    if (!accountModal?.account) return;
    const account = accountModal.account;
    const confirmMessage = account.auditRefCount > 0
      ? `此帳號有 ${account.auditRefCount} 筆操作紀錄，刪除後將改為封存而非真正刪除，是否繼續？`
      : `確定刪除「${accountModal.employee.name}」的登入帳號？此操作無法復原。`;
    if (!confirm(confirmMessage)) return;
    setAccountModal((current) => (current ? { ...current, busy: true, error: "" } : current));
    try {
      const data = await api<unknown>(`/api/admin/users/${account.id}`, { method: "DELETE" });
      const result = extractDeleteResult(data);
      await loadAccounts();
      setMessage(result.message || (result.mode === "archived"
        ? `帳號因有 ${result.auditRefCount} 筆操作紀錄，已改為封存而非刪除。`
        : "帳號已刪除。"));
      setError("");
      closeAccountModal();
    } catch (caught) {
      setAccountModal((current) => (current ? { ...current, busy: false, error: actionErrorMessage(caught, "刪除帳號失敗。") } : current));
    }
  }

  async function copyRevealedSetupUrl() {
    if (!accountModal?.revealSetupUrl) return;
    try {
      await navigator.clipboard.writeText(accountModal.revealSetupUrl);
      setAccountModal((current) => (current ? { ...current, copied: true } : current));
    } catch {
      setAccountModal((current) => (current ? { ...current, error: "自動複製失敗，請手動選取連結文字複製。" } : current));
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
              <tr><th>員工編號</th><th>姓名</th><th>部門／職等</th><th>職稱</th><th>職務類型</th><th>到職日</th><th>狀態</th><th>薪資</th><th>登入帳號</th><th /></tr>
            </thead>
            <tbody>
              {filteredEmployees.map((employee) => {
                const account = accountByEmployee.get(employee.id) ?? null;
                return (
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
                    {accountsError
                      ? <small>帳號功能暫不可用</small>
                      : account
                        ? <>
                            <span class={`status ${account.active ? "ok" : "danger"}`}>{account.active ? "啟用" : "停用"}</span>
                            <small>{account.email}</small>
                          </>
                        : <span class="status">尚無帳號</span>}
                  </td>
                  <td>
                    <div class="row-actions">
                      <button onClick={() => edit(employee)}>編輯</button>
                      {effectiveStatus(employee) === "active"
                        ? <button class="danger-action" onClick={() => void openTerminationModal(employee)}>標記離職</button>
                        : <button onClick={() => void reactivate(employee)}>恢復在職</button>}
                      <button disabled={!!accountsError} onClick={() => openAccountModal(employee)}>帳號管理</button>
                    </div>
                  </td>
                </tr>
                );
              })}
              {filteredEmployees.length === 0 && (
                <tr><td colSpan={10}><div class="empty-state">目前沒有符合篩選條件的員工。</div></td></tr>
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
              <button class="icon-button" onClick={closeTerminationModal}>×</button>
            </div>
            <form onSubmit={confirmTermination}>
              <label>離職日<input type="date" value={terminationDate} onInput={(event) => setTerminationDate(event.currentTarget.value)} required /></label>
              {accountByEmployee.has(terminating.id) && (
                <div class="alert warning">標記離職將自動停用此員工的登入帳號，其將立即無法再登入系統。</div>
              )}
              {responsibilitiesLoading && <small>檢查關鍵職位歸屬中…</small>}
              {responsibilities && responsibilities.length > 0 && (
                <div class="conflict-box">
                  <strong>此員工目前持有 {responsibilities.length} 項關鍵職位身分，建議離職前先完成移轉（僅提醒，不會阻擋離職）：</strong>
                  <ul class="responsibility-list">
                    {responsibilities.map((item) => (
                      <li key={`${item.keyPositionId}-${item.relation}`}>
                        {item.keyPositionTitle}{item.department ? `（${item.department}）` : ""}－{item.relationLabel || (item.relation === "successor" ? "繼任者" : "現任者")}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div class="modal-actions">
                <button type="button" class="secondary" onClick={closeTerminationModal}>取消</button>
                <button class="primary">確認離職</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {accountModal && (
        <div class="modal-backdrop" role="presentation">
          <div class="modal" role="dialog" aria-modal="true" aria-label="帳號管理">
            <div class="modal-title">
              <div><p class="eyebrow">ACCOUNT ACCESS</p><h2>{accountModal.employee.name} 的登入帳號</h2></div>
              {accountModal.view === "manage" && <button class="icon-button" onClick={closeAccountModal}>×</button>}
            </div>
            <Message text={accountModal.error} error />
            {accountModal.view === "reveal" ? (
              <div class="password-reveal">
                {accountModal.revealSetupUrl ? (
                  <>
                    <p>
                      {accountModal.revealContext === "create" ? "帳號已建立" : "密碼已重設"}
                      ，但系統目前無法寄出設定密碼信（尚未設定寄信服務，或寄信失敗），請將以下連結手動轉達給「{accountModal.employee.name}」：
                    </p>
                    <div class="password-reveal-box">
                      {/* 未設定 app_base_url 時後端回傳相對路徑，瀏覽器會依目前頁面（同網域的
                          管理後台）解析成完整網址；點開即可直接測試，複製後貼給對方轉達也可以。 */}
                      <a href={accountModal.revealSetupUrl} target="_blank" rel="noopener noreferrer">
                        <code>{accountModal.revealSetupUrl}</code>
                      </a>
                      <button type="button" class="secondary" onClick={() => void copyRevealedSetupUrl()}>
                        {accountModal.copied ? "已複製" : "複製連結"}
                      </button>
                    </div>
                    <div class="alert warning">
                      此連結只會顯示這一次，請立即複製並轉交。視窗關閉後將無法再從任何地方取得，若日後遺失請使用「重設密碼」重新產生。
                    </div>
                  </>
                ) : (
                  <>
                    <p>{accountModal.revealContext === "create" ? "帳號已建立。" : "密碼已重設。"}</p>
                    <div class="alert success">設定連結已寄至 {accountModal.revealEmail || "該員工的信箱"}。</div>
                    <p class="muted-copy">請提醒「{accountModal.employee.name}」至信箱查看（含垃圾信件匣），點擊連結即可自行設定密碼。</p>
                  </>
                )}
                <div class="modal-actions">
                  <button class="primary" onClick={closeAccountModal}>
                    {accountModal.revealSetupUrl ? "我已複製，關閉視窗" : "關閉"}
                  </button>
                </div>
              </div>
            ) : accountModal.account ? (
              <div class="account-detail">
                <div class="info-grid">
                  <div class="info-field"><dt>Email</dt><dd>{accountModal.account.email}</dd></div>
                  <div class="info-field"><dt>帳號狀態</dt><dd><span class={`status ${accountModal.account.active ? "ok" : "danger"}`}>{accountModal.account.active ? "啟用" : "停用"}</span></dd></div>
                </div>
                <label>
                  角色
                  <select
                    value={accountModal.role}
                    disabled={accountModal.busy}
                    onChange={(event) => void changeAccountRole(event.currentTarget.value as Role)}
                  >
                    <option value="employee">{ROLE_LABEL.employee}</option>
                    <option value="admin">{ROLE_LABEL.admin}</option>
                  </select>
                </label>
                {accountModal.account.mustChangePassword && <small>此帳號尚未完成首次登入的密碼變更。</small>}
                {accountModal.account.auditRefCount > 0 && <small>此帳號有 {accountModal.account.auditRefCount} 筆操作紀錄，刪除時將改為封存。</small>}
                <div class="button-row">
                  <button type="button" class="secondary" disabled={accountModal.busy} onClick={() => void toggleAccountActive()}>
                    {accountModal.account.active ? "停用帳號" : "啟用帳號"}
                  </button>
                  <button type="button" class="secondary" disabled={accountModal.busy} onClick={() => void resetAccountPassword()}>重設密碼</button>
                  <button type="button" class="secondary danger-action" disabled={accountModal.busy} onClick={() => void deleteAccountFromModal()}>刪除帳號</button>
                </div>
              </div>
            ) : (
              <div class="account-detail">
                <p class="muted-copy">此員工尚未建立登入帳號。</p>
                <label>
                  角色
                  <select
                    value={accountModal.role}
                    onChange={(event) => setAccountModal((current) => (current ? { ...current, role: event.currentTarget.value as Role } : current))}
                  >
                    <option value="employee">{ROLE_LABEL.employee}</option>
                    <option value="admin">{ROLE_LABEL.admin}</option>
                  </select>
                </label>
                <div class="modal-actions">
                  <button type="button" class="secondary" onClick={closeAccountModal}>取消</button>
                  <button type="button" class="primary" disabled={accountModal.busy} onClick={() => void createAccountForModal()}>
                    {accountModal.busy ? "建立中…" : "建立帳號"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
