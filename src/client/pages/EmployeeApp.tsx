import { useEffect, useMemo, useState } from "preact/hooks";
import { api, jsonBody } from "../api";
import { MonthCalendar } from "../components/Calendar";
import type { CourseSession, User } from "../types";
import { EmployeeHome, MyCertifications } from "./M2EmployeePages";
import { MyHealthChecksPage } from "./M6EmployeePages";
import { MyProfilePage } from "./EmployeeProfilePages";
import { EmployeeHelpPage } from "./HelpPages";
import { GuidedTour, useOnboardingTour, type TourStep } from "../components/GuidedTour";

type EmployeeTab = "home" | "schedule" | "enroll" | "records" | "certifications" | "healthChecks" | "idp" | "profile" | "help";
const todayMonth = () => new Date().toISOString().slice(0, 7);
function shiftMonth(month: string, delta: number) { const date = new Date(`${month}-01T00:00:00Z`); date.setUTCMonth(date.getUTCMonth() + delta); return date.toISOString().slice(0, 7); }

interface EmployeeAppProps { user: User; onLogout: () => void }

export function EmployeeApp({ user, onLogout }: EmployeeAppProps) {
  const [tab, setTab] = useState<EmployeeTab>("home");
  function openWorkbenchTarget(target: "schedule" | "certifications") {
    setTab(target);
  }
  const tour = useOnboardingTour(user.tourCompleted);
  const tabs: Array<{ id: EmployeeTab; label: string }> = [{ id: "home", label: "首頁" }, { id: "schedule", label: "我的課表" }, { id: "enroll", label: "課程報名" }, { id: "records", label: "我的訓練紀錄" }, { id: "certifications", label: "我的證照" }, { id: "healthChecks", label: "我的健檢" }, { id: "idp", label: "我的 IDP" }, { id: "profile", label: "個人資料" }, { id: "help", label: "使用說明" }];

  /*
   * 員工端只有五步。員工不是天天用這套系統，導覽拉太長反而會被整段略過；
   * 這裡只涵蓋實際上最常做的三件事（看課表、報名、查完成率）與求助入口。
   */
  const tourSteps: TourStep[] = [
    {
      title: `${user.employeeName ?? "你好"}，歡迎使用學習平台`,
      body: <>這裡可以查自己的課表、報名選修課、追蹤必修完成進度，也能看到自己的證照與健檢
        提醒。只有五步，隨時可以按「略過導覽」。</>,
    },
    {
      target: '[data-tour="nav-schedule"]',
      title: "我的課表",
      body: <>人資指派給你的必修課，加上你自己報名的選修課，都在這裡。可以切換月曆或清單檢視。</>,
      before: () => setTab("schedule"),
    },
    {
      target: '[data-tour="nav-enroll"]',
      title: "課程報名",
      body: <>開放報名的選修課在這頁。<strong>名額有限</strong>，額滿就無法報名；若公司設定為
        需審核，送出後要等人資核准才會出現在課表上。</>,
      before: () => setTab("enroll"),
    },
    {
      target: '[data-tour="nav-records"]',
      title: "我的訓練紀錄",
      body: <>最上方是<strong>必修完成率</strong>，下方「尚未完成」列出你還缺的課。
        必修清單依你的職務類型自動推導，部分課程有有效期限，過期後會重新變回未完成。</>,
      before: () => setTab("records"),
    },
    {
      target: '[data-tour="nav-help"]',
      title: "有問題看這裡",
      body: <>各分頁的用途、哪些資料可以自己改、忘記密碼怎麼辦，都寫在使用說明裡，
        也可以從那裡重看本導覽。表單欄位旁的 <strong>?</strong> 則會說明該欄位怎麼填。</>,
      before: () => setTab("help"),
    },
  ];

  return <div class="employee-shell">
    <GuidedTour steps={tourSteps} open={tour.open} onClose={() => { tour.close(); setTab("home"); }} />
    <header class="employee-header"><div class="sidebar-brand"><span>HR</span><strong>HR Learning</strong></div><nav>{tabs.map((item) => <button class={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)} data-tour={`nav-${item.id}`} key={item.id}>{item.label}</button>)}</nav><div><strong>{user.employeeName}</strong><small>{user.department}</small><button class="text-button" onClick={onLogout}>登出</button></div></header>
    <main class="employee-workspace">
      {tab === "home" && <EmployeeHome user={user} onOpenTarget={openWorkbenchTarget} />}
      {tab === "schedule" && <MySchedule />}
      {tab === "enroll" && <CourseEnrollment />}
      {tab === "records" && <MyRecords />}
      {tab === "certifications" && <MyCertifications />}
      {tab === "healthChecks" && <MyHealthChecksPage />}
      {tab === "idp" && <MyIdp />}
      {tab === "profile" && <MyProfilePage />}
      {tab === "help" && <EmployeeHelpPage onReplayTour={tour.replay} />}
    </main>
  </div>;
}

function MySchedule() {
  const [month, setMonth] = useState(todayMonth());
  const [sessions, setSessions] = useState<CourseSession[]>([]);
  const [view, setView] = useState<"calendar" | "list">("calendar");
  const [error, setError] = useState("");
  useEffect(() => { void api<{ sessions: CourseSession[] }>(`/api/employee/schedule?month=${month}`).then((data) => setSessions(data.sessions)).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "讀取失敗。")); }, [month]);
  return <section><div class="page-heading"><div><p class="eyebrow">MY LEARNING</p><h1>我的課表</h1><p>查看已指派與自行報名的場次。</p></div></div>{error && <div class="alert error">{error}</div>}
    <div class="toolbar"><button class="icon-button" onClick={() => setMonth(shiftMonth(month, -1))}>←</button><strong>{month.replace("-", " 年 ")} 月</strong><button class="icon-button" onClick={() => setMonth(shiftMonth(month, 1))}>→</button><div class="segmented"><button class={view === "calendar" ? "active" : ""} onClick={() => setView("calendar")}>月曆</button><button class={view === "list" ? "active" : ""} onClick={() => setView("list")}>清單</button></div></div>
    {view === "calendar" ? <MonthCalendar month={month} sessions={sessions} /> : <div class="card-list">{sessions.map((session) => <article class="list-card"><span class={`level-badge level-${session.competencyLevel}`}>{["", "低", "中", "高"][session.competencyLevel]}</span><div><strong>{session.courseName}</strong><p>{session.sessionDate}・{session.startTime}–{session.endTime}・{session.location}</p></div><span class="status">{session.attendanceStatus === "completed" ? "已完成" : "已排課"}</span></article>)}</div>}
  </section>;
}

interface OpenSession extends CourseSession { description: string; durationHours: number; instructor: string; alreadyEnrolled: number; registrationStatus: "enrolled" | "waitlisted" | null }
function CourseEnrollment() {
  const [sessions, setSessions] = useState<OpenSession[]>([]);
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function load() { try { const data = await api<{ sessions: OpenSession[]; requiresApproval: boolean }>("/api/employee/courses/open"); setSessions(data.sessions); setRequiresApproval(data.requiresApproval); } catch (caught) { setError(caught instanceof Error ? caught.message : "讀取失敗。"); } }
  useEffect(() => { void load(); }, []);
  async function enroll(id: string) { setError(""); setMessage(""); try { const result = await api<{ status: "approved" | "pending" }>(`/api/employee/course-sessions/${id}/enroll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); setMessage(result.status === "pending" ? "報名已送出，請等候 HR 審核。" : "報名成功，場次已加入我的課表。"); await load(); } catch (caught) { setError(caught instanceof Error ? caught.message : "報名失敗。"); } }
  return <section><div class="page-heading"><div><p class="eyebrow">OPEN COURSES</p><h1>課程報名</h1><p>{requiresApproval ? "目前採 HR 審核制；核准後才會加入課表。" : "目前採直接核准；名額內依報名順序錄取。"}</p></div><span class={`status ${requiresApproval ? "warning" : "ok"}`}>{requiresApproval ? "需 HR 審核" : "直接核准"}</span></div>{message && <div class="alert success">{message}</div>}{error && <div class="alert error">{error}</div>}
    <div class="course-grid">{sessions.map((session) => <article class="course-card"><div><span class={`level-badge level-${session.competencyLevel}`}>{["", "低", "中", "高"][session.competencyLevel]}</span><span class="status">選修</span></div><h2>{session.courseName}</h2><p>{session.description}</p><dl><div><dt>日期</dt><dd>{session.sessionDate}</dd></div><div><dt>時間</dt><dd>{session.startTime}–{session.endTime}</dd></div><div><dt>地點</dt><dd>{session.location}</dd></div><div><dt>名額</dt><dd>{session.enrolledCount}/{session.capacity}</dd></div></dl><button class="primary" disabled={session.alreadyEnrolled === 1 || (!requiresApproval && session.enrolledCount >= session.capacity)} onClick={() => void enroll(session.id)}>{session.registrationStatus === "waitlisted" ? "審核中" : session.registrationStatus === "enrolled" ? "已報名" : !requiresApproval && session.enrolledCount >= session.capacity ? "已額滿" : "立即報名"}</button></article>)}</div>
  </section>;
}

interface TrainingRecord { id: string; courseName: string; competencyLevel: number; completedAt: string; hours: number; validUntil: string | null; sessionDate: string }
interface MyCompletion { requiredCount: number; completedCount: number; completionRate: number; missingCourses: Array<{ name: string; competencyLevel: number }> }
function MyRecords() {
  const [records, setRecords] = useState<TrainingRecord[]>([]);
  const [completion, setCompletion] = useState<MyCompletion | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { void api<{ records: TrainingRecord[]; completion: MyCompletion }>("/api/employee/training-records").then((data) => { setRecords(data.records); setCompletion(data.completion); }).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "讀取失敗。")); }, []);
  const hours = useMemo(() => records.reduce((sum, record) => sum + record.hours, 0), [records]);
  return <section><div class="page-heading"><div><p class="eyebrow">MY RECORDS</p><h1>我的訓練紀錄</h1><p>查看必修進度與已完成課程。</p></div></div>{error && <div class="alert error">{error}</div>}
    <div class="metric-row"><div class="metric accent"><span>必修完成率</span><strong>{completion?.completionRate ?? 0}%</strong></div><div class="metric"><span>完成課程</span><strong>{records.length}</strong></div><div class="metric"><span>累積時數</span><strong>{hours}h</strong></div></div>
    <div class="panel"><h2>尚未完成</h2><div class="chip-list">{completion?.missingCourses.map((course) => <span>{["", "低", "中", "高"][course.competencyLevel]}・{course.name}</span>)}{completion?.missingCourses.length === 0 && <span class="done-chip">所有必修均已完成</span>}</div></div>
    <div class="table-card"><table><thead><tr><th>課程</th><th>完成日</th><th>時數</th><th>有效至</th></tr></thead><tbody>{records.map((record) => <tr><td><span class={`level-badge level-${record.competencyLevel}`}>{["", "低", "中", "高"][record.competencyLevel]}</span> <strong>{record.courseName}</strong></td><td>{record.sessionDate}</td><td>{record.hours}h</td><td>{record.validUntil ?? "永久"}</td></tr>)}</tbody></table>{records.length === 0 && <div class="empty-state">尚無完訓紀錄。</div>}</div>
  </section>;
}

// ---- M5：我的 IDP（對應 src/server/m5.ts，base /api/employee/idp）----
// 員工僅能查看與更新自己的 IDP 計畫；狀態／備註以外欄位由 admin 管理。
interface MyIdpItem { id: string; idpPlanId: string; action: string; dueDate: string; status: string; employeeNotes: string }
interface MyIdpPlan { id: string; title: string; goal: string; startDate: string; dueDate: string; status: string; items: MyIdpItem[] }
const IDP_PLAN_STATUS_LABEL: Record<string, string> = { draft: "草稿", active: "進行中", completed: "已完成", cancelled: "已取消" };
const IDP_ITEM_STATUS_LABEL: Record<string, string> = { pending: "待處理", in_progress: "進行中", completed: "已完成" };

function MyIdp() {
  const [plans, setPlans] = useState<MyIdpPlan[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load() {
    try {
      const data = await api<{ idpPlans: MyIdpPlan[] }>("/api/employee/idp");
      setPlans(data.idpPlans.map((plan) => ({ ...plan, items: plan.items ?? [] })));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法讀取 IDP 計畫。");
    }
  }
  useEffect(() => { void load(); }, []);

  function updateItemLocal(planId: string, itemId: string, patch: Partial<MyIdpItem>) {
    setPlans((current) => current.map((plan) => plan.id === planId
      ? { ...plan, items: plan.items.map((item) => item.id === itemId ? { ...item, ...patch } : item) }
      : plan));
  }

  async function saveItem(item: MyIdpItem) {
    setError(""); setMessage("");
    try {
      await api(`/api/employee/idp/items/${item.id}`, {
        method: "PATCH",
        ...jsonBody({ status: item.status, employeeNotes: item.employeeNotes }),
      });
      setMessage("行動項目已更新。");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法更新行動項目。");
    }
  }

  return <section>
    <div class="page-heading"><div><p class="eyebrow">MY DEVELOPMENT</p><h1>我的 IDP</h1><p>查看個人發展計畫，更新行動項目進度與備註。</p></div></div>
    {message && <div class="alert success">{message}</div>}{error && <div class="alert error">{error}</div>}
    <div class="card-list">
      {plans.map((plan) => (
        <article class="panel" key={plan.id}>
          <div class="panel-heading">
            <div>
              <span class={`status ${plan.status === "completed" ? "ok" : plan.status === "cancelled" ? "danger" : "warning"}`}>{IDP_PLAN_STATUS_LABEL[plan.status] ?? plan.status}</span>
              <h2>{plan.title}</h2>
              <small>{plan.startDate} ～ {plan.dueDate}</small>
            </div>
          </div>
          <p>{plan.goal}</p>
          <div class="checklist-list">
            {plan.items.map((item) => (
              <div class="checklist-row" key={item.id}>
                <div><strong>{item.action}</strong><small>期限：{item.dueDate}</small></div>
                <div class="idp-item-fields idp-item-fields-employee">
                  <select value={item.status} onChange={(event) => updateItemLocal(plan.id, item.id, { status: event.currentTarget.value })}>
                    {Object.entries(IDP_ITEM_STATUS_LABEL).map(([value, label]) => <option value={value}>{label}</option>)}
                  </select>
                  <input value={item.employeeNotes} onInput={(event) => updateItemLocal(plan.id, item.id, { employeeNotes: event.currentTarget.value })} placeholder="我的備註" />
                  <button class="secondary" onClick={() => void saveItem(item)}>儲存</button>
                </div>
              </div>
            ))}
            {plan.items.length === 0 && <div class="empty-state">此計畫尚無行動項目。</div>}
          </div>
        </article>
      ))}
      {plans.length === 0 && <div class="empty-state">目前沒有指派給你的 IDP 計畫。</div>}
    </div>
  </section>;
}
