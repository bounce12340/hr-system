import { useEffect, useMemo, useState } from "preact/hooks";
import { api, ApiClientError, jsonBody } from "../api";
import { MonthCalendar } from "../components/Calendar";
import {
  AdminDashboard,
  EnrollmentApprovalPage,
  MandatoryTrainingPage,
  TestsPage,
  TrainingMatrixPage,
} from "./M2AdminPages";
import { RecruitmentPage } from "./M3AdminPages";
import { ReportsPage } from "./M4AdminPages";
import { TalentManagementPage } from "./M5AdminPages";
import { HealthAndCertificationsPage } from "./M6AdminPages";
import { EmployeeManagementPage } from "./EmployeeAdminPages";
import { AttendanceManagementPage } from "./AttendanceAdminPages";
import { SystemSettingsPage } from "./SettingsAdminPages";
import { AdminHelpPage } from "./HelpPages";
import { GuidedTour, useOnboardingTour, type TourStep } from "../components/GuidedTour";
import { Field, FieldHelp } from "../components/FieldHelp";
import type {
  AssignmentEmployee,
  CompletionEmployee,
  Course,
  CourseSession,
  SpecialDay,
  User,
} from "../types";

/**
 * 側邊欄分組。原本 17 個項目平鋪，其中「招募」「人才盤點」「健康與證照」已用
 * 頁內二級 tab 分組，其餘攤平——同一份側邊欄裡並存兩種層級邏輯。
 *
 * 此處只合併**使用情境上確實同類**的項目，不為了減少數量硬湊：
 * - 排課＝開課到結案的同一條作業流；重要日子存在的目的就是約束排課。
 * - 訓練追蹤＝純檢視訓練成效，不做資料登錄。
 * 出缺勤與報表雖有資料流關係（前者是後者的資料來源）但使用情境不同，維持分開。
 */
type AdminTab =
  | "dashboard"
  | "employees"
  | "scheduling"
  | "training"
  | "health"
  | "attendance-management"
  | "recruitment"
  | "reports"
  | "talent"
  | "settings"
  | "help";

type SchedulingSection = "calendar" | "courses" | "enrollment-approval" | "attendance" | "special-days";
type TrainingSection = "completion" | "mandatory-training" | "training-matrix" | "tests";

const LEVEL_LABEL = ["", "低", "中", "高"];
const todayMonth = () => new Date().toISOString().slice(0, 7);
const todayDate = () => new Date().toISOString().slice(0, 10);

function shiftMonth(month: string, delta: number): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0, 7);
}

function Message({ text, error = false }: { text: string; error?: boolean }) {
  if (!text) return null;
  return <div class={`alert ${error ? "error" : "success"}`}>{text}</div>;
}

interface AdminAppProps {
  user: User;
  onLogout: () => void;
}

export function AdminApp({ user, onLogout }: AdminAppProps) {
  const [tab, setTab] = useState<AdminTab>("dashboard");
  const tour = useOnboardingTour(user.tourCompleted);
  const tabs: Array<{ id: AdminTab; label: string }> = [
    { id: "dashboard", label: "管理儀表板" },
    { id: "employees", label: "員工管理" },
    { id: "scheduling", label: "排課" },
    { id: "training", label: "訓練追蹤" },
    { id: "health", label: "健康與證照" },
    { id: "attendance-management", label: "出缺勤管理" },
    { id: "recruitment", label: "招募管理" },
    { id: "reports", label: "報表" },
    { id: "talent", label: "人才盤點" },
    { id: "settings", label: "系統設定" },
    { id: "help", label: "使用說明" },
  ];

  /*
   * 導覽步驟。before() 會真的切換分頁，讓聚光燈後面就是使用者接下來要操作的
   * 畫面——只講不切的導覽等於看簡報，回到系統還是不知道東西在哪。
   *
   * 步驟刻意只有六步且集中在「順序」上：初次使用者的困難不是找不到按鈕，而是
   * 不知道該先做哪一件（必修級距沒設好，後面全盤皆錯）。細節交給使用說明頁與
   * 欄位問號，不塞進導覽。
   */
  const tourSteps: TourStep[] = [
    {
      title: "歡迎使用人資學習排課系統",
      body: <>這套系統的核心是<strong>自動算出「誰該上什麼課」</strong>：依每位員工的職務類型
        推導必修清單、排課時預先勾選應上名單、課後登錄出席就自動更新完訓進度。
        接下來六步帶你看一遍主要位置，隨時可以按「略過導覽」。</>,
    },
    {
      target: '[data-tour="admin-nav"]',
      title: "左側是全部功能",
      body: <>十個功能區。<strong>排課</strong>與<strong>訓練追蹤</strong>點進去後上方還有次分頁，
        相關作業都收在同一區裡。手機版時這裡會收合成上方的下拉選單。</>,
    },
    {
      target: '[data-tour="nav-settings"]',
      title: "先從這裡開始：必修級距",
      body: <>「職務類型」決定每個職務的<strong>必修級距</strong>，而必修是「級距以下全包」的
        累進式。這是所有必修計算的源頭，<strong>沒設對，完訓率與排課名單都會是錯的</strong>，
        所以請先確認這一項再建員工。</>,
      before: () => setTab("settings"),
    },
    {
      target: '[data-tour="nav-employees"]',
      title: "接著建立員工",
      body: <>可逐筆新增或用 CSV 批次匯入，並在此開立公司帳號——系統會寄出一次性密碼設定
        連結，由本人自行設定密碼，過程中不會產生需要人工轉達的明碼密碼。
        建議一併填生日，健檢應檢日需要它才算得出來。</>,
      before: () => setTab("employees"),
    },
    {
      target: '[data-tour="nav-scheduling"]',
      title: "排課是一條完整作業流",
      body: <>課程管理建課 → 排課月曆開場次（系統自動算應上名單、擋時段衝突）→ 報名審核 →
        課後在出席登錄逐人登錄。登錄為「完成」會<strong>自動寫入訓練紀錄</strong>，
        不需要另外補登。</>,
      before: () => setTab("scheduling"),
    },
    {
      target: '[data-tour="nav-help"]',
      title: "不確定某個欄位要填什麼？",
      body: <>表單欄位旁的 <strong>?</strong> 可以看該欄位的用途與填寫方式（滑鼠移上去，
        手機點一下）。名詞定義、計算規則與常見問題都在這頁，也可以從這裡重看本導覽。</>,
      before: () => setTab("help"),
    },
  ];

  return (
    <div class="app-shell">
      <GuidedTour
        steps={tourSteps}
        open={tour.open}
        onClose={() => {
          tour.close();
          // 導覽最後停在「使用說明」，但那不是日常起點；結束時回到儀表板，
          // 使用者才會從系統實際的首頁開始用。
          setTab("dashboard");
        }}
      />
      <aside class="sidebar">
        <div class="sidebar-brand"><span>HR</span><strong>HR Learning</strong></div>
        <nav data-tour="admin-nav">
          {tabs.map((item) => (
            <button
              class={tab === item.id ? "active" : ""}
              onClick={() => setTab(item.id)}
              data-tour={`nav-${item.id}`}
              key={item.id}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div class="sidebar-user">
          <strong>{user.employeeName ?? user.email}</strong>
          <span>HR 管理者</span>
          <button class="text-button" onClick={onLogout}>登出</button>
        </div>
      </aside>
      <main class="workspace">
        {/*
          行動版（900px 以下）側邊欄整個 display:none，而登出按鈕原本只存在於
          側邊欄內，導致手機上沒有任何登出途徑。此處補上，維持與側邊欄一致的出口。
        */}
        <header class="mobile-header">
          <strong>HR Learning</strong>
          <div class="mobile-header-actions">
            <select value={tab} onChange={(event) => setTab(event.currentTarget.value as AdminTab)}>
              {tabs.map((item) => <option value={item.id}>{item.label}</option>)}
            </select>
            <button class="text-button" onClick={onLogout}>登出</button>
          </div>
        </header>
        {tab === "dashboard" && <AdminDashboard />}
        {tab === "employees" && <EmployeeManagementPage />}
        {tab === "scheduling" && <SchedulingGroupPage />}
        {tab === "training" && <TrainingGroupPage />}
        {tab === "health" && <HealthAndCertificationsPage />}
        {tab === "attendance-management" && <AttendanceManagementPage />}
        {tab === "recruitment" && <RecruitmentPage />}
        {tab === "reports" && <ReportsPage />}
        {tab === "talent" && <TalentManagementPage />}
        {tab === "settings" && <SystemSettingsPage />}
        {tab === "help" && <AdminHelpPage onReplayTour={tour.replay} />}
      </main>
    </div>
  );
}

/** 二級分頁列。與招募（.recruitment-nav）、人才盤點（.talent-nav）共用同一套外觀。 */
function GroupNav<T extends string>({ sections, current, onChange, label }: {
  sections: Array<{ id: T; label: string }>;
  current: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div class="group-nav" role="tablist" aria-label={label}>
      {sections.map((item) => (
        <button
          class={current === item.id ? "active" : ""}
          onClick={() => onChange(item.id)}
          role="tab"
          aria-selected={current === item.id}
          key={item.id}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 排課：開課到結案的同一條作業流。重要日子（封鎖日／全員必訓日）也放這裡——
 * 它存在的目的就是約束排課，脫離排課情境沒有意義。
 */
function SchedulingGroupPage() {
  const [section, setSection] = useState<SchedulingSection>("calendar");
  return (
    <>
      <GroupNav
        label="排課分頁"
        current={section}
        onChange={setSection}
        sections={[
          { id: "calendar", label: "排課月曆" },
          { id: "courses", label: "課程管理" },
          { id: "enrollment-approval", label: "報名審核" },
          { id: "attendance", label: "出席登錄" },
          { id: "special-days", label: "重要日子" },
        ]}
      />
      {section === "calendar" && <AdminCalendar />}
      {section === "courses" && <CourseManagement />}
      {section === "enrollment-approval" && <EnrollmentApprovalPage />}
      {section === "attendance" && <AttendancePage />}
      {section === "special-days" && <SpecialDaysPage />}
    </>
  );
}

/** 訓練追蹤：四者都是檢視訓練成效，不做資料登錄。 */
function TrainingGroupPage() {
  const [section, setSection] = useState<TrainingSection>("completion");
  return (
    <>
      <GroupNav
        label="訓練追蹤分頁"
        current={section}
        onChange={setSection}
        sections={[
          { id: "completion", label: "完訓追蹤" },
          { id: "mandatory-training", label: "必修訓練清單" },
          { id: "training-matrix", label: "訓練矩陣" },
          { id: "tests", label: "測驗紀錄" },
        ]}
      />
      {section === "completion" && <CompletionPage />}
      {section === "mandatory-training" && <MandatoryTrainingPage />}
      {section === "training-matrix" && <TrainingMatrixPage />}
      {section === "tests" && <TestsPage />}
    </>
  );
}

function AdminCalendar() {
  const [month, setMonth] = useState(todayMonth());
  const [view, setView] = useState<"calendar" | "list">("calendar");
  const [sessions, setSessions] = useState<CourseSession[]>([]);
  const [specialDays, setSpecialDays] = useState<SpecialDay[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [preview, setPreview] = useState<AssignmentEmployee[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    courseId: "",
    sessionDate: todayDate(),
    startTime: "09:00",
    endTime: "12:00",
    location: "總公司 A 教室",
    capacity: 20,
    notes: "",
    forceConflicts: false,
    conflictOverrideReason: "",
  });

  async function load() {
    try {
      const [calendar, courseData] = await Promise.all([
        api<{ sessions: CourseSession[]; specialDays: SpecialDay[] }>(`/api/admin/calendar?month=${month}`),
        api<{ courses: Course[] }>("/api/admin/courses"),
      ]);
      setSessions(calendar.sessions);
      setSpecialDays(calendar.specialDays);
      setCourses(courseData.courses);
      if (!form.courseId && courseData.courses[0]) {
        setForm((current) => ({ ...current, courseId: courseData.courses[0]?.id ?? "" }));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法讀取排課資料。");
    }
  }

  useEffect(() => { void load(); }, [month]);

  async function runPreview() {
    setError("");
    try {
      const data = await api<{ employees: AssignmentEmployee[]; specialDay: SpecialDay | null }>(
        "/api/admin/course-sessions/assignment-preview",
        { method: "POST", ...jsonBody(form) },
      );
      setPreview(data.employees);
      setSelected(new Set(data.employees.filter((employee) => employee.recommended).map((employee) => employee.id)));
    } catch (caught) {
      setPreview([]);
      setError(caught instanceof Error ? caught.message : "無法計算指派名單。");
    }
  }

  async function createSession(event: Event) {
    event.preventDefault();
    setError("");
    setMessage("");
    try {
      const data = await api<{ assignedCount: number; conflicts: unknown[] }>("/api/admin/course-sessions", {
        method: "POST",
        ...jsonBody({ ...form, selectedEmployeeIds: [...selected] }),
      });
      setMessage(`場次已建立，指派 ${data.assignedCount} 人。`);
      setFormOpen(false);
      setPreview([]);
      await load();
    } catch (caught) {
      const details = caught instanceof ApiClientError ? caught.details : undefined;
      setError(caught instanceof Error ? caught.message : "建立場次失敗。");
      if (details && typeof details === "object") setForm((current) => ({ ...current, forceConflicts: false }));
    }
  }

  function openForDate(date: string) {
    setForm((current) => ({ ...current, sessionDate: date }));
    setFormOpen(true);
    setPreview([]);
    setError("");
  }

  const selectedConflicts = preview.filter(
    (employee) => selected.has(employee.id) && employee.conflicts.length > 0,
  );

  return (
    <section>
      <div class="page-heading">
        <div><p class="eyebrow">M1 LEARNING SCHEDULE</p><h1>排課月曆</h1><p>掌握場次、重要日子與人員衝突。</p></div>
        <button class="primary" onClick={() => setFormOpen(true)}>＋ 新增場次</button>
      </div>
      <Message text={message} /><Message text={error} error />
      <div class="toolbar">
        <button class="icon-button" onClick={() => setMonth(shiftMonth(month, -1))}>←</button>
        <strong>{month.replace("-", " 年 ")} 月</strong>
        <button class="icon-button" onClick={() => setMonth(shiftMonth(month, 1))}>→</button>
        <div class="segmented">
          <button class={view === "calendar" ? "active" : ""} onClick={() => setView("calendar")}>月曆</button>
          <button class={view === "list" ? "active" : ""} onClick={() => setView("list")}>清單</button>
        </div>
      </div>
      {view === "calendar" ? (
        <MonthCalendar month={month} sessions={sessions} specialDays={specialDays} onDateClick={openForDate} />
      ) : (
        <div class="card-list">
          {sessions.map((session) => (
            <article class="list-card" key={session.id}>
              <span class={`level-badge level-${session.competencyLevel}`}>{LEVEL_LABEL[session.competencyLevel]}</span>
              <div><strong>{session.courseName}</strong><p>{session.sessionDate}・{session.startTime}–{session.endTime}・{session.location}</p></div>
              <span>{session.enrolledCount}/{session.capacity} 人</span>
            </article>
          ))}
          {sessions.length === 0 && <div class="empty-state">本月尚無場次。</div>}
        </div>
      )}

      {formOpen && (
        <div class="modal-backdrop" role="presentation">
          <div class="modal wide" role="dialog" aria-modal="true" aria-label="新增場次">
            <div class="modal-title"><div><p class="eyebrow">NEW SESSION</p><h2>新增開課場次</h2></div><button class="icon-button" onClick={() => setFormOpen(false)}>×</button></div>
            <form onSubmit={createSession}>
              <div class="form-grid">
                <label>課程<select value={form.courseId} onChange={(event) => setForm({ ...form, courseId: event.currentTarget.value })} required>
                  {courses.map((course) => <option value={course.id}>{LEVEL_LABEL[course.competencyLevel]}・{course.name}</option>)}
                </select></label>
                <label>日期<input type="date" value={form.sessionDate} onInput={(event) => setForm({ ...form, sessionDate: event.currentTarget.value })} required /></label>
                <label>開始<input type="time" value={form.startTime} onInput={(event) => setForm({ ...form, startTime: event.currentTarget.value })} required /></label>
                <label>結束<input type="time" value={form.endTime} onInput={(event) => setForm({ ...form, endTime: event.currentTarget.value })} required /></label>
                <label>地點<input value={form.location} onInput={(event) => setForm({ ...form, location: event.currentTarget.value })} required /></label>
                <Field
                  label="名額"
                  help={<>這個場次最多容納幾人。員工端報名額滿後就無法自行報名；
                    HR 在下方名單直接指派則不受名額限制。</>}
                ><input type="number" min="1" value={form.capacity} onInput={(event) => setForm({ ...form, capacity: Number(event.currentTarget.value) })} required /></Field>
                <label class="full">備註<textarea value={form.notes} onInput={(event) => setForm({ ...form, notes: event.currentTarget.value })} /></label>
              </div>
              <button type="button" class="secondary" onClick={runPreview}>計算應上名單與衝突</button>
              {preview.length > 0 && (
                <div class="assignment-panel">
                  <div class="assignment-summary"><strong>已選 {selected.size} / {preview.length} 人</strong><span>必修符合級距者已預勾</span></div>
                  <div class="assignment-list">
                    {preview.map((employee) => (
                      <label class={`employee-check ${employee.conflicts.length ? "has-conflict" : ""}`} key={employee.id}>
                        <input
                          type="checkbox"
                          checked={selected.has(employee.id)}
                          onChange={(event) => {
                            const next = new Set(selected);
                            if (event.currentTarget.checked) next.add(employee.id); else next.delete(employee.id);
                            setSelected(next);
                          }}
                        />
                        <span><strong>{employee.name}</strong><small>{employee.department}・{employee.jobType}</small></span>
                        {employee.recommended && <em>應上</em>}
                        {employee.conflicts.length > 0 && <b>衝突 {employee.conflicts[0]?.courseName}</b>}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              {selectedConflicts.length > 0 && (
                <div class="conflict-box">
                  <strong>有 {selectedConflicts.length} 人時段衝突</strong>
                  <div class="field">
                    <label class="inline-check"><input type="checkbox" checked={form.forceConflicts} onChange={(event) => setForm({ ...form, forceConflicts: event.currentTarget.checked })} /> 經確認後強制覆寫</label>
                    <FieldHelp label="強制覆寫">這些人在同一天的重疊時段已有其他課。勾選後仍會排入，
                      並將覆寫紀錄與原因寫入稽核軌跡。請先確認當事人能實際出席再勾。</FieldHelp>
                  </div>
                  {form.forceConflicts && (
                    <Field
                      label="覆寫原因"
                      help={<>會存進稽核紀錄，供日後查核為何允許衝突排課。
                        請寫具體理由（例如「另一堂課改期」），不要只寫「已確認」。</>}
                    ><input value={form.conflictOverrideReason} onInput={(event) => setForm({ ...form, conflictOverrideReason: event.currentTarget.value })} required /></Field>
                  )}
                </div>
              )}
              <Message text={error} error />
              <div class="modal-actions"><button type="button" class="secondary" onClick={() => setFormOpen(false)}>取消</button><button class="primary" disabled={preview.length === 0}>建立場次</button></div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}

function CourseManagement() {
  const empty = { name: "", competencyLevel: 1, courseType: "mandatory", durationHours: 2, instructor: "", description: "", relatedCertificationId: "", validityMonths: "", enrollmentOpen: false, active: true };
  const [courses, setCourses] = useState<Course[]>([]);
  const [certifications, setCertifications] = useState<Array<{ id: string; name: string }>>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(empty);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load() {
    try {
      const [courseData, certificationData] = await Promise.all([
        api<{ courses: Course[] }>("/api/admin/courses?includeInactive=true"),
        api<{ certifications: Array<{ id: string; name: string }> }>("/api/admin/certifications/options"),
      ]);
      setCourses(courseData.courses);
      setCertifications(certificationData.certifications);
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : "讀取失敗。"); }
  }
  useEffect(() => { void load(); }, []);

  async function save(event: Event) {
    event.preventDefault(); setError(""); setMessage("");
    const payload = {
      ...form,
      relatedCertificationId: form.relatedCertificationId || null,
      validityMonths: form.validityMonths === "" ? null : Number(form.validityMonths),
    };
    try {
      await api(editingId ? `/api/admin/courses/${editingId}` : "/api/admin/courses", {
        method: editingId ? "PATCH" : "POST", ...jsonBody(payload),
      });
      setMessage(editingId ? "課程已更新。" : "課程已建立。");
      setEditingId(null); setForm(empty); await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "儲存失敗。"); }
  }

  function edit(course: Course) {
    setEditingId(course.id);
    setForm({
      name: course.name, competencyLevel: course.competencyLevel, courseType: course.courseType,
      durationHours: course.durationHours, instructor: course.instructor, description: course.description,
      relatedCertificationId: course.relatedCertificationId ?? "",
      validityMonths: course.validityMonths === null ? "" : String(course.validityMonths),
      enrollmentOpen: course.enrollmentOpen === 1, active: course.active === 1,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function archive(id: string) {
    if (!confirm("確定停用此課程？既有訓練紀錄會保留。")) return;
    try { await api(`/api/admin/courses/${id}`, { method: "DELETE" }); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "停用失敗。"); }
  }

  return (
    <section>
      <div class="page-heading"><div><p class="eyebrow">COURSE CATALOG</p><h1>課程管理</h1><p>維護職能級別、必選修與效期。</p></div></div>
      <Message text={message} /><Message text={error} error />
      <div class="split-layout">
        <form class="panel sticky-form" onSubmit={save}>
          <h2>{editingId ? "編輯課程" : "新增課程"}</h2>
          <label>名稱<input value={form.name} onInput={(event) => setForm({ ...form, name: event.currentTarget.value })} required /></label>
          <div class="form-grid">
            <Field
              label="級別"
              help={<>課程的職能級別。員工的必修清單是<strong>級距以下全包</strong>的累進式——
                職務類型設為「中」的員工，必修包含所有低階與中階課程，不是只有中階。</>}
            ><select value={form.competencyLevel} onChange={(event) => setForm({ ...form, competencyLevel: Number(event.currentTarget.value) })}><option value="1">低</option><option value="2">中</option><option value="3">高</option></select></Field>
            <Field
              label="類型"
              help={<>必修會依級距自動列入員工的應上清單並計入完成率；選修不影響完成率，
                需另外開放報名才看得到。</>}
            ><select value={form.courseType} onChange={(event) => setForm({ ...form, courseType: event.currentTarget.value })}><option value="mandatory">必修</option><option value="elective">選修</option></select></Field>
            <Field
              label="時數"
              help={<>單場課程時數，計入員工的累積訓練時數。可填 0.5 的倍數。</>}
            ><input type="number" min="0.5" step="0.5" value={form.durationHours} onInput={(event) => setForm({ ...form, durationHours: Number(event.currentTarget.value) })} /></Field>
            <Field
              label="效期（月）"
              help={<>完訓後多久需要重上。到期後這門課會<strong>重新變回未完成</strong>，
                用於需定期複訓的課程。<strong>留白表示終身有效</strong>，完成一次就不再過期。</>}
            ><input type="number" min="1" value={form.validityMonths} onInput={(event) => setForm({ ...form, validityMonths: event.currentTarget.value })} placeholder="無效期" /></Field>
          </div>
          <label>講師<input value={form.instructor} onInput={(event) => setForm({ ...form, instructor: event.currentTarget.value })} required /></label>
          <Field
            label="關聯證照（選填）"
            help={<>將這門課對應到一張證照，方便在「健康與證照」追蹤誰上過對應課程。
              不確定時留「不關聯」即可，日後可再補。</>}
          ><select value={form.relatedCertificationId} onChange={(event) => setForm({ ...form, relatedCertificationId: event.currentTarget.value })}><option value="">不關聯</option>{certifications.map((certification) => <option value={certification.id}>{certification.name}</option>)}</select></Field>
          <label>說明<textarea value={form.description} onInput={(event) => setForm({ ...form, description: event.currentTarget.value })} /></label>
          <div class="field">
            <label class="inline-check"><input type="checkbox" checked={form.enrollmentOpen} onChange={(event) => setForm({ ...form, enrollmentOpen: event.currentTarget.checked })} /> 開放員工報名（選修）</label>
            <FieldHelp label="開放員工報名">勾選後，這門課會出現在員工端的「課程報名」頁供自行報名。
              必修課由系統指派，通常不需要勾。</FieldHelp>
          </div>
          <div class="field">
            <label class="inline-check"><input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.currentTarget.checked })} /> 啟用</label>
            <FieldHelp label="啟用">取消勾選等於停用：不能再開新場次，也不會列入必修計算，
              但<strong>既有的訓練紀錄完整保留</strong>。停辦的課請停用而不要刪除。</FieldHelp>
          </div>
          <div class="button-row"><button class="primary">{editingId ? "更新" : "建立"}</button>{editingId && <button type="button" class="secondary" onClick={() => { setEditingId(null); setForm(empty); }}>取消</button>}</div>
        </form>
        <div class="table-card">
          <table><thead><tr><th>級別</th><th>課程</th><th>類型</th><th>時數</th><th>講師</th><th>狀態</th><th /></tr></thead>
            <tbody>{courses.map((course) => <tr key={course.id}>
              <td><span class={`level-badge level-${course.competencyLevel}`}>{LEVEL_LABEL[course.competencyLevel]}</span></td>
              <td><strong>{course.name}</strong><small>{course.description}</small></td>
              <td>{course.courseType === "mandatory" ? "必修" : "選修"}</td><td>{course.durationHours}h</td><td>{course.instructor}</td>
              <td><span class={`status ${course.active ? "ok" : "muted"}`}>{course.active ? "啟用" : "停用"}</span></td>
              <td><div class="row-actions"><button onClick={() => edit(course)}>編輯</button>{course.active === 1 && <button onClick={() => void archive(course.id)}>停用</button>}</div></td>
            </tr>)}</tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

interface AttendanceRecord {
  employeeId: string;
  employeeNo: string;
  name: string;
  department: string;
  attendanceStatus: "pending" | "completed" | "absent" | "leave";
}

function AttendancePage() {
  const [sessions, setSessions] = useState<CourseSession[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    void api<{ sessions: CourseSession[] }>("/api/admin/course-sessions").then((data) => setSessions(data.sessions)).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "讀取失敗。"));
  }, []);
  async function loadRecords(id: string) {
    setSelectedId(id); setError("");
    try { setRecords((await api<{ records: AttendanceRecord[] }>(`/api/admin/course-sessions/${id}/attendance`)).records); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "讀取失敗。"); }
  }
  async function save() {
    setError(""); setMessage("");
    if (records.some((record) => record.attendanceStatus === "pending")) {
      setError("請先為名單中的每位員工選擇完成、缺席或請假。");
      return;
    }
    try {
      await api(`/api/admin/course-sessions/${selectedId}/attendance`, {
        method: "PUT",
        ...jsonBody({ records: records.map((record) => ({ employeeId: record.employeeId, status: record.attendanceStatus })) }),
      });
      setMessage("出席結果已儲存，完訓紀錄同步更新。");
      await loadRecords(selectedId);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "儲存失敗。"); }
  }
  return (
    <section><div class="page-heading"><div><p class="eyebrow">ATTENDANCE</p><h1>出席登錄</h1><p>場次結束後逐人登錄，完成者自動寫入訓練紀錄。</p></div></div>
      <Message text={message} /><Message text={error} error />
      <div class="split-layout attendance-layout">
        <div class="card-list session-picker">{sessions.map((session) => <button class={`list-card ${selectedId === session.id ? "selected" : ""}`} onClick={() => void loadRecords(session.id)} key={session.id}><div><strong>{session.courseName}</strong><p>{session.sessionDate}・{session.startTime}–{session.endTime}</p></div><span>{session.status}</span></button>)}</div>
        <div class="panel">{selectedId ? <><div class="panel-heading"><h2>出席名單</h2><button class="primary" onClick={save}>儲存結果</button></div>
          <div class="attendance-list">{records.map((record, index) => <div class="attendance-row" key={record.employeeId}><div><strong>{record.name}</strong><small>{record.employeeNo}・{record.department}</small></div><select value={record.attendanceStatus} onChange={(event) => setRecords(records.map((item, itemIndex) => itemIndex === index ? { ...item, attendanceStatus: event.currentTarget.value as AttendanceRecord["attendanceStatus"] } : item))}><option value="pending">待登錄</option><option value="completed">完成</option><option value="absent">缺席</option><option value="leave">請假</option></select></div>)}</div>
        </> : <div class="empty-state">請先選擇一個場次。</div>}</div>
      </div>
    </section>
  );
}

function CompletionPage() {
  const [employees, setEmployees] = useState<CompletionEmployee[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [department, setDepartment] = useState("");
  const [error, setError] = useState("");
  async function load() {
    try {
      const data = await api<{ employees: CompletionEmployee[]; departments: string[] }>(`/api/admin/completion${department ? `?department=${encodeURIComponent(department)}` : ""}`);
      setEmployees(data.employees); setDepartments(data.departments);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "讀取失敗。"); }
  }
  useEffect(() => { void load(); }, [department]);
  const average = useMemo(() => employees.length ? Math.round(employees.reduce((sum, employee) => sum + employee.completionRate, 0) / employees.length) : 0, [employees]);
  return (
    <section><div class="page-heading"><div><p class="eyebrow">COMPLETION</p><h1>完訓追蹤</h1><p>依職務級距計算每位員工的必修完成率。</p></div><label class="compact-label">部門<select value={department} onChange={(event) => setDepartment(event.currentTarget.value)}><option value="">全部部門</option>{departments.map((item) => <option value={item}>{item}</option>)}</select></label></div>
      <Message text={error} error />
      <div class="metric-row"><div class="metric"><span>範圍人數</span><strong>{employees.length}</strong></div><div class="metric accent"><span>平均完成率</span><strong>{average}%</strong></div><div class="metric"><span>待完成項目</span><strong>{employees.reduce((sum, item) => sum + item.missingCourses.length, 0)}</strong></div></div>
      <div class="table-card"><table><thead><tr><th>員工</th><th>職務類型</th><th>必修進度</th><th>完成率</th><th>未完成課程</th></tr></thead><tbody>{employees.map((employee) => <tr key={employee.id}><td><strong>{employee.name}</strong><small>{employee.department}・{employee.employeeNo}</small></td><td>{employee.jobType}</td><td>{employee.completedCount}/{employee.requiredCount}</td><td><div class="progress-cell"><div class="progress"><span style={{ width: `${employee.completionRate}%` }} /></div><b>{employee.completionRate}%</b></div></td><td><div class="chip-list">{employee.missingCourses.map((course) => <span>{LEVEL_LABEL[course.competencyLevel]}・{course.name}</span>)}{employee.missingCourses.length === 0 && <span class="done-chip">已完成</span>}</div></td></tr>)}</tbody></table></div>
    </section>
  );
}

function SpecialDaysPage() {
  const empty = { specialDate: todayDate(), dayType: "blackout", title: "", reason: "" };
  const [days, setDays] = useState<SpecialDay[]>([]);
  const [form, setForm] = useState(empty);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function load() { try { setDays((await api<{ specialDays: SpecialDay[] }>("/api/admin/special-days")).specialDays); } catch (caught) { setError(caught instanceof Error ? caught.message : "讀取失敗。"); } }
  useEffect(() => { void load(); }, []);
  async function save(event: Event) {
    event.preventDefault(); setError(""); setMessage("");
    try {
      await api(editingId ? `/api/admin/special-days/${editingId}` : "/api/admin/special-days", { method: editingId ? "PATCH" : "POST", ...jsonBody(form) });
      setMessage(editingId ? "重要日子已更新。" : "重要日子已建立。"); setEditingId(null); setForm(empty); await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "儲存失敗。"); }
  }
  async function remove(id: string) { if (!confirm("確定刪除此重要日子？")) return; try { await api(`/api/admin/special-days/${id}`, { method: "DELETE" }); await load(); } catch (caught) { setError(caught instanceof Error ? caught.message : "刪除失敗。"); } }
  return (
    <section><div class="page-heading"><div><p class="eyebrow">SPECIAL DAYS</p><h1>重要日子</h1><p>封鎖日禁止排課；全員必訓日自動指派所有在職員工。</p></div></div><Message text={message} /><Message text={error} error />
      <div class="split-layout"><form class="panel sticky-form" onSubmit={save}><h2>{editingId ? "編輯設定" : "新增重要日子"}</h2><label>日期<input type="date" value={form.specialDate} onInput={(event) => setForm({ ...form, specialDate: event.currentTarget.value })} /></label><Field label="類型" help={<><strong>封鎖日</strong>：當天禁止排課，系統會擋下並顯示你填的原因，
  用於連假、年度盤點這類全公司都不能受訓的日子。<br /><strong>全員必訓日</strong>：當天的場次會自動指派
  所有在職員工，用於法遵類全員訓練。</>}><select value={form.dayType} onChange={(event) => setForm({ ...form, dayType: event.currentTarget.value })}><option value="blackout">封鎖日</option><option value="mandatory_all">全員必訓日</option></select></Field><label>名稱<input value={form.title} onInput={(event) => setForm({ ...form, title: event.currentTarget.value })} required /></label><label>原因<textarea value={form.reason} onInput={(event) => setForm({ ...form, reason: event.currentTarget.value })} /></label><div class="button-row"><button class="primary">{editingId ? "更新" : "建立"}</button>{editingId && <button type="button" class="secondary" onClick={() => { setEditingId(null); setForm(empty); }}>取消</button>}</div></form>
        <div class="card-list">{days.map((day) => <article class={`special-day-card ${day.dayType}`} key={day.id}><div class="date-block"><strong>{day.specialDate.slice(8)}</strong><span>{day.specialDate.slice(0, 7)}</span></div><div><span class="status">{day.dayType === "blackout" ? "封鎖日" : "全員必訓"}</span><h3>{day.title}</h3><p>{day.reason}</p></div><div class="row-actions"><button onClick={() => { setEditingId(day.id); setForm({ specialDate: day.specialDate, dayType: day.dayType, title: day.title, reason: day.reason }); }}>編輯</button><button onClick={() => void remove(day.id)}>刪除</button></div></article>)}</div>
      </div>
    </section>
  );
}
