import { useEffect, useMemo, useState } from "preact/hooks";
import { api, jsonBody } from "../api";
import { CertificationReminderList, expiryText } from "../components/CertificationReminderList";
import { monthsUntilDueText } from "../components/HealthCheckHelpers";
import { Field } from "../components/FieldHelp";
import type {
  CertificationReminder,
  CertificationType,
  CourseSession,
  EmployeeCertification,
  HealthCheckDueEntry,
  MandatoryTrainingEmployee,
  TrainingSettings,
} from "../types";

const LEVEL_LABEL = ["", "低", "中", "高"];
const todayDate = () => new Date().toISOString().slice(0, 10);

function Message({ text, error = false }: { text: string; error?: boolean }) {
  if (!text) return null;
  return <div class={`alert ${error ? "error" : "success"}`}>{text}</div>;
}

export function AdminDashboard() {
  const [data, setData] = useState<{
    settings: TrainingSettings;
    certificationReminders: CertificationReminder[];
    probationReminders: Array<{
      id: string;
      employeeName: string;
      employeeNo: string;
      department: string;
      dueDate: string;
      daysUntilDue: number;
    }>;
    pendingEnrollmentCount: number;
    retrainingRequiredCount: number;
    missingMandatoryCount: number;
    // 健檢到期提醒：規格要求併入既有提醒中心，由後端在 /api/admin/dashboard
    // 回應中附加。欄位為選填——後端尚未加上前，畫面單純不顯示這個區塊。
    healthCheckReminders?: HealthCheckDueEntry[];
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void api<NonNullable<typeof data>>("/api/admin/dashboard")
      .then(setData)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "讀取失敗。"));
  }, []);
  return <section>
    <div class="page-heading"><div><p class="eyebrow">HR REMINDER CENTER</p><h1>管理儀表板</h1><p>集中掌握證照、試用期、待審報名與補訓事項。</p></div></div>
    <Message text={error} error />
    <div class="metric-row">
      <div class="metric accent"><span>證照到期提醒</span><strong>{data?.certificationReminders.length ?? 0}</strong></div>
      {data?.healthCheckReminders && <div class="metric"><span>健檢到期提醒</span><strong>{data.healthCheckReminders.length}</strong></div>}
      <div class="metric"><span>試用期到期提醒</span><strong>{data?.probationReminders.length ?? 0}</strong></div>
      <div class="metric"><span>待審報名</span><strong>{data?.pendingEnrollmentCount ?? 0}</strong></div>
      <div class="metric"><span>測驗需補訓</span><strong>{data?.retrainingRequiredCount ?? 0}</strong></div>
      <div class="metric"><span>未完成必修</span><strong>{data?.missingMandatoryCount ?? 0}</strong></div>
    </div>
    <div class="panel">
      <div class="panel-heading"><div><h2>證照到期提醒</h2><small>提前 {data?.settings.certificationReminderDays ?? 60} 天顯示</small></div></div>
      <CertificationReminderList
        reminders={data?.certificationReminders ?? []}
        showEmployee
        emptyText="目前沒有到期提醒。"
      />
    </div>
    {data?.healthCheckReminders && data.healthCheckReminders.length > 0 && (
      <div class="panel section-title">
        <div class="panel-heading"><div><h2>健檢到期提醒</h2><small>詳細名單請至「健康與證照 → 待健檢名單」</small></div></div>
        <div class="reminder-list">
          {data.healthCheckReminders.map((entry) => (
            <article class="reminder-card" key={entry.employeeId}>
              <div class="reminder-icon">健</div>
              <div><strong>{entry.name}</strong><p>{entry.employeeNo}・{entry.department}・下次應檢日 {entry.nextDueDate ?? "—"}</p></div>
              <span class={entry.status === "overdue" ? "urgent" : ""}>{monthsUntilDueText(entry.monthsUntilDue)}</span>
            </article>
          ))}
        </div>
      </div>
    )}
    <div class="panel section-title">
      <div class="panel-heading"><div><h2>試用期到期提醒</h2><small>提醒天數可在「招募管理 → 試用期」設定</small></div></div>
      <div class="reminder-list">
        {(data?.probationReminders ?? []).map((reminder) => (
          <article class="reminder-card">
            <div class="reminder-icon">試</div>
            <div><strong>{reminder.employeeName}</strong><p>{reminder.employeeNo}・{reminder.department}・到期日 {reminder.dueDate}</p></div>
            <span class={reminder.daysUntilDue <= 7 ? "urgent" : ""}>{reminder.daysUntilDue < 0 ? `逾期 ${Math.abs(reminder.daysUntilDue)} 天` : `${reminder.daysUntilDue} 天後`}</span>
          </article>
        ))}
        {(data?.probationReminders.length ?? 0) === 0 && <div class="empty-state">目前沒有試用期到期提醒。</div>}
      </div>
    </div>
  </section>;
}

export function MandatoryTrainingPage() {
  const [employees, setEmployees] = useState<MandatoryTrainingEmployee[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [department, setDepartment] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const query = department ? `?department=${encodeURIComponent(department)}` : "";
    void api<{ employees: MandatoryTrainingEmployee[]; departments: string[] }>(
      `/api/admin/mandatory-training${query}`,
    ).then((data) => {
      setEmployees(data.employees);
      setDepartments(data.departments);
    }).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "讀取失敗。"));
  }, [department]);
  return <section>
    <div class="page-heading">
      <div><p class="eyebrow">MANDATORY TRAINING</p><h1>必修訓練清單</h1><p>依職務級距自動推得，逐人對照完成狀態。</p></div>
      <label class="compact-label">部門<select value={department} onChange={(event) => setDepartment(event.currentTarget.value)}><option value="">全部部門</option>{departments.map((item) => <option value={item}>{item}</option>)}</select></label>
    </div>
    <Message text={error} error />
    <div class="table-card"><table class="mandatory-table"><thead><tr><th>員工</th><th>職務／職等</th><th>進度</th><th>逐課完成比較</th></tr></thead><tbody>
      {employees.map((employee) => <tr key={employee.employeeId}>
        <td><strong>{employee.employeeName}</strong><small>{employee.employeeNo}・{employee.department}</small></td>
        <td>{employee.jobType}<small>{employee.grade}・必修至{LEVEL_LABEL[employee.requiredLevel]}級</small></td>
        <td><div class="progress-cell"><div class="progress"><span style={{ width: `${employee.completionRate}%` }} /></div><b>{employee.completedCount}/{employee.requiredCount}（{employee.completionRate}%）</b></div></td>
        <td><div class="course-status-list">{employee.courses.map((course) => <span class={course.completed ? "completed" : "missing"} title={course.completedAt ?? "尚未完成"}>{course.completed ? "✓" : "○"} {LEVEL_LABEL[course.competencyLevel]}・{course.courseName}</span>)}</div></td>
      </tr>)}
    </tbody></table></div>
  </section>;
}

interface EnrollmentRequest {
  id: string;
  status: "waitlisted" | "enrolled" | "cancelled";
  requestedAt: string;
  reviewedAt: string | null;
  reviewNote: string;
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  department: string;
  courseName: string;
  sessionDate: string;
  startTime: string;
  endTime: string;
  location: string;
}

export function EnrollmentApprovalPage() {
  const [requests, setRequests] = useState<EnrollmentRequest[]>([]);
  const [settings, setSettings] = useState<TrainingSettings | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function load() {
    try {
      const data = await api<{ requests: EnrollmentRequest[]; settings: TrainingSettings }>("/api/admin/enrollment-requests");
      setRequests(data.requests);
      setSettings(data.settings);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "讀取失敗。"); }
  }
  useEffect(() => { void load(); }, []);
  async function toggleApproval(requiresApproval: boolean) {
    if (!settings) return;
    setError(""); setMessage("");
    try {
      const data = await api<{ settings: TrainingSettings }>("/api/admin/training-settings", {
        method: "PATCH",
        ...jsonBody({ ...settings, electiveEnrollmentRequiresApproval: requiresApproval }),
      });
      setSettings(data.settings);
      setMessage(requiresApproval ? "已切換為 admin 審核制。" : "已切換為直接自動核准。");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "設定失敗。"); }
  }
  async function decide(id: string, action: "approve" | "reject") {
    setError(""); setMessage("");
    const note = prompt(action === "approve" ? "核准備註（可留空）" : "請輸入駁回原因（可留空）") ?? "";
    try {
      await api(`/api/admin/enrollment-requests/${id}`, {
        method: "PATCH",
        ...jsonBody({ action, note }),
      });
      setMessage(action === "approve" ? "報名已核准並加入員工課表。" : "報名已駁回。");
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "審核失敗。"); }
  }
  const pending = requests.filter((request) => request.status === "waitlisted");
  return <section>
    <div class="page-heading"><div><p class="eyebrow">ENROLLMENT WORKFLOW</p><h1>課程報名審核</h1><p>依設定直接放行，或由 HR 逐筆核准。</p></div></div>
    <Message text={message} /><Message text={error} error />
    <div class="setting-banner">
      <div><strong>目前模式：{settings?.electiveEnrollmentRequiresApproval ? "Admin 審核" : "直接自動核准"}</strong><p>切換後只影響新送出的選修報名。</p></div>
      <div class="segmented"><button class={!settings?.electiveEnrollmentRequiresApproval ? "active" : ""} onClick={() => void toggleApproval(false)}>直接核准</button><button class={settings?.electiveEnrollmentRequiresApproval ? "active" : ""} onClick={() => void toggleApproval(true)}>需審核</button></div>
    </div>
    <h2>待審申請（{pending.length}）</h2>
    <div class="card-list">{pending.map((request) => <article class="list-card" key={request.id}><div><strong>{request.employeeName}・{request.courseName}</strong><p>{request.department}・{request.sessionDate} {request.startTime}–{request.endTime}・{request.location}</p></div><div class="row-actions"><button onClick={() => void decide(request.id, "approve")}>核准</button><button class="danger-action" onClick={() => void decide(request.id, "reject")}>駁回</button></div></article>)}{pending.length === 0 && <div class="empty-state">目前沒有待審報名。</div>}</div>
    <h2 class="section-title">最近報名紀錄</h2>
    <div class="table-card"><table><thead><tr><th>員工</th><th>課程場次</th><th>狀態</th><th>審核備註</th></tr></thead><tbody>{requests.filter((request) => request.status !== "waitlisted").slice(0, 30).map((request) => <tr><td><strong>{request.employeeName}</strong><small>{request.employeeNo}</small></td><td>{request.courseName}<small>{request.sessionDate} {request.startTime}</small></td><td><span class={`status ${request.status === "enrolled" ? "ok" : "danger"}`}>{request.status === "enrolled" ? "已核准" : "已取消／駁回"}</span></td><td>{request.reviewNote || "—"}</td></tr>)}</tbody></table></div>
  </section>;
}

interface TestResult {
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  department: string;
  score: number | null;
  passed: number | null;
  retrainingRequired: number | null;
}

interface TrainingTest {
  id: string;
  courseSessionId: string;
  name: string;
  passingScore: number;
  courseName: string;
  sessionDate: string;
  startTime: string;
  endTime: string;
  results: TestResult[];
}

export function TestsPage() {
  const [sessions, setSessions] = useState<CourseSession[]>([]);
  const [tests, setTests] = useState<TrainingTest[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [form, setForm] = useState({ courseSessionId: "", name: "", passingScore: 70 });
  const [scores, setScores] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{ courseSessionId: string; name: string; passingScore: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function load() {
    setLoading(true);
    try {
      const [sessionData, testData] = await Promise.all([
        api<{ sessions: CourseSession[] }>("/api/admin/course-sessions"),
        api<{ tests: TrainingTest[] }>("/api/admin/tests"),
      ]);
      setSessions(sessionData.sessions);
      setTests(testData.tests);
      setForm((current) => ({ ...current, courseSessionId: current.courseSessionId || sessionData.sessions[0]?.id || "" }));
      setError("");
      return testData.tests;
    } catch (caught) { setError(caught instanceof Error ? caught.message : "讀取失敗。"); return null; }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  const selected = tests.find((test) => test.id === selectedId) ?? null;
  function hasUnsavedScores(test: TrainingTest | null = selected) {
    return Boolean(test?.results.some((result) => {
      const draft = scores[result.employeeId] ?? "";
      const saved = result.score === null ? "" : String(result.score);
      return draft !== saved;
    }));
  }
  function selectTest(id: string) {
    if (busy || loading || id === selectedId) return;
    const target = tests.find((test) => test.id === id) ?? null;
    const editingDirty = Boolean(editing && selected && (
      editing.courseSessionId !== selected.courseSessionId ||
      editing.name !== selected.name || editing.passingScore !== selected.passingScore
    ));
    if ((hasUnsavedScores() || editingDirty) && !confirm("切換測驗會捨棄尚未儲存的編輯內容，確定繼續？")) return;
    setScores(Object.fromEntries((target?.results ?? []).map((result) => [result.employeeId, result.score === null ? "" : String(result.score)])));
    setSelectedId(id);
    setEditing(null); setMessage(""); setError("");
  }
  async function create(event: Event) {
    event.preventDefault();
    if (busy || loading) return;
    setError(""); setMessage(""); setBusy(true);
    try {
      await api("/api/admin/tests", { method: "POST", ...jsonBody(form) });
      setMessage("測驗已建立。"); setForm((current) => ({ ...current, name: "", passingScore: 70 })); await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "建立失敗。"); }
    finally { setBusy(false); }
  }
  function beginEdit() {
    if (busy || loading) return;
    if (selected) { setEditing({ courseSessionId: selected.courseSessionId, name: selected.name, passingScore: selected.passingScore }); setMessage(""); setError(""); }
  }
  async function saveEdit(event: Event) {
    event.preventDefault();
    if (busy || loading || !selected || !editing) return;
    const changingSession = editing.courseSessionId !== selected.courseSessionId;
    if (changingSession && selected.results.some((result) => result.score !== null)) {
      setError("此測驗已有成績，不能更換場次；請保留原場次以維持成績關聯。"); return;
    }
    setBusy(true); setError(""); setMessage("");
    try {
      await api(`/api/admin/tests/${selected.id}`, { method: "PATCH", ...jsonBody(editing) });
      setEditing(null); setMessage("測驗設定已儲存，既有成績已依新門檻重新判定。");
      if (changingSession) {
        setScores({});
        const reloadedTests = await load();
        if (reloadedTests) {
          const reloaded = reloadedTests.find((test) => test.id === selected.id);
          setScores(Object.fromEntries((reloaded?.results ?? []).map((result) => [result.employeeId, result.score === null ? "" : String(result.score)])));
        }
      } else {
        await load();
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "更新失敗。"); }
    finally { setBusy(false); }
  }
  async function saveResults() {
    if (busy || loading || !selected) return;
    const records = selected.results
      .map((result) => ({ employeeId: result.employeeId, rawScore: scores[result.employeeId] ?? "" }))
      .filter((record) => record.rawScore !== "")
      .map((record) => ({ employeeId: record.employeeId, score: Number(record.rawScore) }));
    if (records.some((record) => !Number.isFinite(record.score) || record.score < 0 || record.score > 100)) {
      setError("成績必須是 0 至 100 的有效數字。"); return;
    }
    if (records.length === 0) { setError("請至少輸入一筆成績。"); return; }
    setBusy(true); setError(""); setMessage("");
    try {
      await api(`/api/admin/tests/${selected.id}/results`, { method: "PUT", ...jsonBody({ records }) });
      setMessage("成績已儲存，通過與補訓狀態已更新。"); await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "儲存失敗。"); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    if (busy || loading) return;
    if (!confirm("確定刪除此測驗與所有成績？")) return;
    setBusy(true); setError(""); setMessage("");
    try { await api(`/api/admin/tests/${id}`, { method: "DELETE" }); setSelectedId(""); setScores({}); setEditing(null); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "刪除失敗。"); }
    finally { setBusy(false); }
  }
  return <section>
    <div class="page-heading"><div><p class="eyebrow">TEST RECORDS</p><h1>測驗紀錄</h1><p>依場次建立測驗、登錄分數並自動標記補訓。</p></div></div>
    <Message text={message} /><Message text={error} error />{loading && <p role="status">讀取中…</p>}
    <div class="split-layout">
      <div><form class="panel" onSubmit={create}><h2>新增場次測驗</h2><label>場次<select value={form.courseSessionId} onChange={(event) => setForm({ ...form, courseSessionId: event.currentTarget.value })}>{sessions.map((session) => <option value={session.id}>{session.sessionDate}・{session.courseName}</option>)}</select></label><label>測驗名稱<input value={form.name} onInput={(event) => setForm({ ...form, name: event.currentTarget.value })} required /></label><Field label="通過門檻" help={<>及格分數（0–100）。低於此分數的人會被標為<strong>需補訓</strong>，並出現在管理儀表板的「測驗需補訓」提醒中。</>}><input type="number" min="0" max="100" step="0.1" value={form.passingScore} onInput={(event) => setForm({ ...form, passingScore: Number(event.currentTarget.value) })} required /></Field><button class="primary" disabled={busy || loading || !form.courseSessionId}>{busy ? "處理中…" : "建立測驗"}</button></form>
        <div class="card-list section-title">{tests.map((test) => <button type="button" class={`list-card ${selectedId === test.id ? "selected" : ""}`} disabled={busy} onClick={() => selectTest(test.id)}><div><strong>{test.name}</strong><p>{test.courseName}・{test.sessionDate}・及格 {test.passingScore}</p></div><span>{test.results.filter((result) => result.score !== null).length}/{test.results.length}</span></button>)}</div>
      </div>
      <div class="panel">{selected ? <><div class="panel-heading"><div><h2>{selected.name}</h2><small>及格門檻 {selected.passingScore} 分</small></div><div class="row-actions"><button type="button" class="secondary" disabled={busy} onClick={beginEdit}>編輯測驗</button><button type="button" class="secondary" disabled={busy} onClick={() => void remove(selected.id)}>刪除測驗</button></div></div>
        {editing && <form class="panel" onSubmit={(event) => void saveEdit(event)} aria-label="編輯測驗"><h3>編輯測驗設定</h3><label>場次<select required value={editing.courseSessionId} disabled={busy || loading || selected.results.some((result) => result.score !== null)} onChange={(event) => setEditing({ ...editing, courseSessionId: event.currentTarget.value })}>{sessions.map((session) => <option value={session.id}>{session.sessionDate}・{session.courseName}</option>)}</select></label><label>測驗名稱<input required disabled={busy || loading} maxLength={200} value={editing.name} onInput={(event) => setEditing({ ...editing, name: event.currentTarget.value })} /></label><Field label="通過門檻" help="調整後會立即依新門檻重算所有已登錄成績的通過／補訓狀態。已有成績時不可更換場次。"><input aria-label="編輯通過門檻" disabled={busy || loading} type="number" min="0" max="100" step="0.1" required value={editing.passingScore} onInput={(event) => setEditing({ ...editing, passingScore: Number(event.currentTarget.value) })} /></Field><button class="primary" disabled={busy}>{busy ? "儲存中…" : "儲存測驗設定"}</button><button type="button" disabled={busy || loading} onClick={() => { setEditing(null); setError(""); setMessage(""); }}>取消編輯</button></form>}
        <div class="score-list">{selected.results.map((result) => <label class="score-row"><span><strong>{result.employeeName}</strong><small>{result.employeeNo}・{result.department}</small></span><input disabled={busy || loading} type="number" min="0" max="100" step="0.1" value={scores[result.employeeId] ?? ""} onInput={(event) => setScores({ ...scores, [result.employeeId]: event.currentTarget.value })} placeholder="分數" /><em class={result.retrainingRequired ? "fail" : result.passed ? "pass" : ""}>{result.score === null ? "未登錄" : result.passed ? "通過" : "需補訓"}</em></label>)}</div><button class="primary" disabled={busy || loading} onClick={() => void saveResults()}>{busy ? "處理中…" : "儲存成績"}</button></> : <div class="empty-state">請選擇測驗以登錄成績。</div>}</div>
    </div>
  </section>;
}


interface EmployeeOption {
  id: string;
  employeeNo: string;
  name: string;
  department: string;
}

export function CertificationsPage() {
  const emptyCert = { employeeId: "", certificationId: "", certificateNumber: "", issuedAt: todayDate(), expiresAt: "", notes: "" };
  const emptyType = { name: "", issuer: "", defaultValidityMonths: "", active: true };
  const [certifications, setCertifications] = useState<EmployeeCertification[]>([]);
  const [types, setTypes] = useState<CertificationType[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [settings, setSettings] = useState<TrainingSettings | null>(null);
  const [form, setForm] = useState(emptyCert);
  const [typeForm, setTypeForm] = useState(emptyType);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTypeId, setEditingTypeId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function load() {
    try {
      const [certData, typeData, employeeData] = await Promise.all([
        api<{ certifications: EmployeeCertification[]; settings: TrainingSettings }>("/api/admin/employee-certifications"),
        api<{ certificationTypes: CertificationType[] }>("/api/admin/certification-types"),
        api<{ employees: EmployeeOption[] }>("/api/admin/employees"),
      ]);
      setCertifications(certData.certifications); setSettings(certData.settings);
      setTypes(typeData.certificationTypes); setEmployees(employeeData.employees);
      setForm((current) => ({ ...current, employeeId: current.employeeId || employeeData.employees[0]?.id || "", certificationId: current.certificationId || typeData.certificationTypes.find((item) => item.active)?.id || "" }));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "讀取失敗。"); }
  }
  useEffect(() => { void load(); }, []);
  async function saveCert(event: Event) {
    event.preventDefault(); setError(""); setMessage("");
    try {
      await api(editingId ? `/api/admin/employee-certifications/${editingId}` : "/api/admin/employee-certifications", {
        method: editingId ? "PATCH" : "POST",
        ...jsonBody({ ...form, expiresAt: form.expiresAt || null }),
      });
      setMessage(editingId ? "員工證照已更新。" : "員工證照已新增。");
      setEditingId(null); setForm({ ...emptyCert, employeeId: employees[0]?.id ?? "", certificationId: types.find((item) => item.active)?.id ?? "" }); await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "儲存失敗。"); }
  }
  async function saveType(event: Event) {
    event.preventDefault(); setError(""); setMessage("");
    try {
      await api(editingTypeId ? `/api/admin/certification-types/${editingTypeId}` : "/api/admin/certification-types", {
        method: editingTypeId ? "PATCH" : "POST",
        ...jsonBody({ ...typeForm, defaultValidityMonths: typeForm.defaultValidityMonths === "" ? null : Number(typeForm.defaultValidityMonths) }),
      });
      setMessage(editingTypeId ? "證照類型已更新。" : "證照類型已新增。"); setEditingTypeId(null); setTypeForm(emptyType); await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "儲存失敗。"); }
  }
  async function removeCert(id: string) {
    if (!confirm("確定刪除此員工證照？")) return;
    try { await api(`/api/admin/employee-certifications/${id}`, { method: "DELETE" }); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "刪除失敗。"); }
  }
  async function updateReminderDays(value: number) {
    if (!settings) return;
    try {
      const data = await api<{ settings: TrainingSettings }>("/api/admin/training-settings", {
        method: "PATCH",
        ...jsonBody({ ...settings, certificationReminderDays: value }),
      });
      setSettings(data.settings); setMessage(`到期提醒已調整為提前 ${value} 天。`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "設定失敗。"); }
  }
  function editCert(certification: EmployeeCertification) {
    setEditingId(certification.id); setForm({
      employeeId: certification.employeeId,
      certificationId: certification.certificationId,
      certificateNumber: certification.certificateNumber ?? "",
      issuedAt: certification.issuedAt,
      expiresAt: certification.expiresAt ?? "",
      notes: certification.notes,
    });
  }
  return <section>
    <div class="page-heading"><div><p class="eyebrow">CERTIFICATIONS</p><h1>證照管理</h1><p>維護證照類型、員工持證資料與到期提醒。</p></div><label class="compact-label">提前提醒天數<input type="number" min="1" max="3650" value={settings?.certificationReminderDays ?? 60} onChange={(event) => void updateReminderDays(Number(event.currentTarget.value))} /></label></div>
    <Message text={message} /><Message text={error} error />
    <div class="cert-layout">
      <form class="panel" onSubmit={saveCert}><h2>{editingId ? "編輯員工證照" : "新增員工證照"}</h2><label>員工<select value={form.employeeId} onChange={(event) => setForm({ ...form, employeeId: event.currentTarget.value })}>{employees.map((employee) => <option value={employee.id}>{employee.employeeNo}・{employee.name}</option>)}</select></label><label>證照類型<select value={form.certificationId} onChange={(event) => setForm({ ...form, certificationId: event.currentTarget.value })}>{types.filter((item) => item.active || item.id === form.certificationId).map((item) => <option value={item.id}>{item.name}・{item.issuer}</option>)}</select></label><label>證號<input value={form.certificateNumber} onInput={(event) => setForm({ ...form, certificateNumber: event.currentTarget.value })} /></label><div class="form-grid"><label>取得日<input type="date" value={form.issuedAt} onInput={(event) => setForm({ ...form, issuedAt: event.currentTarget.value })} required /></label><Field label="到期日" help={<>到期前會依「提前提醒天數」出現在管理儀表板的證照提醒中。
  <strong>留空表示終身有效</strong>，不會產生任何提醒。</>}><input type="date" value={form.expiresAt} onInput={(event) => setForm({ ...form, expiresAt: event.currentTarget.value })} /></Field></div><label>備註<textarea value={form.notes} onInput={(event) => setForm({ ...form, notes: event.currentTarget.value })} /></label><div class="button-row"><button class="primary">{editingId ? "更新" : "新增"}</button>{editingId && <button type="button" class="secondary" onClick={() => { setEditingId(null); setForm(emptyCert); }}>取消</button>}</div></form>
      <form class="panel" onSubmit={saveType}><h2>{editingTypeId ? "編輯證照類型" : "新增證照類型"}</h2><label>名稱<input value={typeForm.name} onInput={(event) => setTypeForm({ ...typeForm, name: event.currentTarget.value })} required /></label><label>發證單位<input value={typeForm.issuer} onInput={(event) => setTypeForm({ ...typeForm, issuer: event.currentTarget.value })} required /></label><Field label="預設效期（月）" help={<>新增員工證照時用來自動推算到期日的預設值，
  <strong>登錄時仍可逐筆覆寫</strong>。終身有效的證照請留空。</>}><input type="number" min="1" value={typeForm.defaultValidityMonths} onInput={(event) => setTypeForm({ ...typeForm, defaultValidityMonths: event.currentTarget.value })} /></Field><label class="inline-check"><input type="checkbox" checked={typeForm.active} onChange={(event) => setTypeForm({ ...typeForm, active: event.currentTarget.checked })} /> 啟用</label><div class="button-row"><button class="primary">{editingTypeId ? "更新" : "新增類型"}</button>{editingTypeId && <button type="button" class="secondary" onClick={() => { setEditingTypeId(null); setTypeForm(emptyType); }}>取消</button>}</div><div class="type-list">{types.map((type) => <button type="button" class={type.active ? "" : "inactive"} onClick={() => { setEditingTypeId(type.id); setTypeForm({ name: type.name, issuer: type.issuer, defaultValidityMonths: type.defaultValidityMonths === null ? "" : String(type.defaultValidityMonths), active: type.active === 1 }); }}><strong>{type.name}</strong><small>{type.issuer}・{type.defaultValidityMonths ? `${type.defaultValidityMonths} 個月` : "無預設效期"}</small></button>)}</div></form>
    </div>
    <div class="table-card section-title"><table><thead><tr><th>員工</th><th>證照／發證單位</th><th>證號</th><th>取得／到期</th><th>提醒狀態</th><th /></tr></thead><tbody>{certifications.map((certification) => <tr key={certification.id}><td><strong>{certification.employeeName}</strong><small>{certification.employeeNo}・{certification.department}</small></td><td>{certification.certificationName}<small>{certification.issuer}</small></td><td>{certification.certificateNumber || "—"}</td><td>{certification.issuedAt}<small>{certification.expiresAt ?? "永久"}</small></td><td>{certification.daysUntilExpiry === null ? <span class="status">無期限</span> : <span class={`status ${certification.daysUntilExpiry <= (settings?.certificationReminderDays ?? 60) ? "danger" : "ok"}`}>{expiryText(certification.daysUntilExpiry)}</span>}</td><td><div class="row-actions"><button onClick={() => editCert(certification)}>編輯</button><button class="danger-action" onClick={() => void removeCert(certification.id)}>刪除</button></div></td></tr>)}</tbody></table></div>
  </section>;
}

interface MatrixData {
  jobTypes: Array<{ id: string; name: string; requiredLevel: number; employeeCount: number }>;
  courses: Array<{ id: string; name: string; competencyLevel: number }>;
  cells: Array<{
    jobTypeId: string;
    courseId: string;
    required: boolean;
    employeeCount: number;
    completedCount: number;
    completionRate: number | null;
    status: "red" | "yellow" | "green" | "not_required";
  }>;
  thresholds: { green: number; yellow: number };
}

export function TrainingMatrixPage() {
  const [data, setData] = useState<MatrixData | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void api<MatrixData>("/api/admin/training-matrix").then(setData)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "讀取失敗。"));
  }, []);
  const cellMap = useMemo(() => new Map(data?.cells.map((cell) => [`${cell.jobTypeId}:${cell.courseId}`, cell])), [data]);
  return <section>
    <div class="page-heading"><div><p class="eyebrow">TRAINING MATRIX</p><h1>職務別訓練矩陣</h1><p>職務類型 × 必修課程，全員完成度以紅黃綠顯示。</p></div></div>
    <Message text={error} error />
    <div class="matrix-legend"><span><i class="green" /> 綠 ≥ {data?.thresholds.green ?? 80}%</span><span><i class="yellow" /> 黃 ≥ {data?.thresholds.yellow ?? 50}%</span><span><i class="red" /> 紅 &lt; {data?.thresholds.yellow ?? 50}%</span><span><i class="na" /> 非必修</span></div>
    <div class="table-card matrix-scroll"><table class="matrix-table"><thead><tr><th class="sticky-column">職務類型</th>{data?.courses.map((course) => <th><span class={`level-badge level-${course.competencyLevel}`}>{LEVEL_LABEL[course.competencyLevel]}</span><small>{course.name}</small></th>)}</tr></thead><tbody>{data?.jobTypes.map((jobType) => <tr><th class="sticky-column"><strong>{jobType.name}</strong><small>{jobType.employeeCount} 人・必修至{LEVEL_LABEL[jobType.requiredLevel]}級</small></th>{data.courses.map((course) => { const cell = cellMap.get(`${jobType.id}:${course.id}`); return <td><div class={`matrix-cell ${cell?.status ?? "not_required"}`}>{cell?.completionRate === null || cell === undefined ? <><strong>—</strong><small>非必修</small></> : <><strong>{cell.completionRate}%</strong><small>{cell.completedCount}/{cell.employeeCount} 人</small></>}</div></td>; })}</tr>)}</tbody></table></div>
  </section>;
}
