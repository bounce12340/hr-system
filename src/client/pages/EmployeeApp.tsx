import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api";
import { MonthCalendar } from "../components/Calendar";
import type { CourseSession, User } from "../types";

type EmployeeTab = "schedule" | "enroll" | "records";
const todayMonth = () => new Date().toISOString().slice(0, 7);
function shiftMonth(month: string, delta: number) { const date = new Date(`${month}-01T00:00:00Z`); date.setUTCMonth(date.getUTCMonth() + delta); return date.toISOString().slice(0, 7); }

interface EmployeeAppProps { user: User; onLogout: () => void }

export function EmployeeApp({ user, onLogout }: EmployeeAppProps) {
  const [tab, setTab] = useState<EmployeeTab>("schedule");
  const tabs: Array<{ id: EmployeeTab; label: string }> = [{ id: "schedule", label: "我的課表" }, { id: "enroll", label: "課程報名" }, { id: "records", label: "我的訓練紀錄" }];
  return <div class="employee-shell">
    <header class="employee-header"><div class="sidebar-brand"><span>UI</span><strong>HR Learning</strong></div><nav>{tabs.map((item) => <button class={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>{item.label}</button>)}</nav><div><strong>{user.employeeName}</strong><small>{user.department}</small><button class="text-button" onClick={onLogout}>登出</button></div></header>
    <main class="employee-workspace">
      {tab === "schedule" && <MySchedule />}
      {tab === "enroll" && <CourseEnrollment />}
      {tab === "records" && <MyRecords />}
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

interface OpenSession extends CourseSession { description: string; durationHours: number; instructor: string; alreadyEnrolled: number }
function CourseEnrollment() {
  const [sessions, setSessions] = useState<OpenSession[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function load() { try { setSessions((await api<{ sessions: OpenSession[] }>("/api/employee/courses/open")).sessions); } catch (caught) { setError(caught instanceof Error ? caught.message : "讀取失敗。"); } }
  useEffect(() => { void load(); }, []);
  async function enroll(id: string) { setError(""); setMessage(""); try { await api(`/api/employee/course-sessions/${id}/enroll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); setMessage("報名成功，場次已加入我的課表。"); await load(); } catch (caught) { setError(caught instanceof Error ? caught.message : "報名失敗。"); } }
  return <section><div class="page-heading"><div><p class="eyebrow">OPEN COURSES</p><h1>課程報名</h1><p>選修課名額內依報名順序錄取。</p></div></div>{message && <div class="alert success">{message}</div>}{error && <div class="alert error">{error}</div>}
    <div class="course-grid">{sessions.map((session) => <article class="course-card"><div><span class={`level-badge level-${session.competencyLevel}`}>{["", "低", "中", "高"][session.competencyLevel]}</span><span class="status">選修</span></div><h2>{session.courseName}</h2><p>{session.description}</p><dl><div><dt>日期</dt><dd>{session.sessionDate}</dd></div><div><dt>時間</dt><dd>{session.startTime}–{session.endTime}</dd></div><div><dt>地點</dt><dd>{session.location}</dd></div><div><dt>名額</dt><dd>{session.enrolledCount}/{session.capacity}</dd></div></dl><button class="primary" disabled={session.alreadyEnrolled === 1 || session.enrolledCount >= session.capacity} onClick={() => void enroll(session.id)}>{session.alreadyEnrolled === 1 ? "已報名" : session.enrolledCount >= session.capacity ? "已額滿" : "立即報名"}</button></article>)}</div>
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
