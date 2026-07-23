import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import type {
  CertificationReminder,
  MandatoryTrainingEmployee,
  TrainingSettings,
  User,
} from "../types";

const LEVEL_LABEL = ["", "低", "中", "高"];

function expiryText(days: number): string {
  if (days < 0) return `已逾期 ${Math.abs(days)} 天`;
  if (days === 0) return "今天到期";
  return `${days} 天後到期`;
}

export function EmployeeHome({ user }: { user: User }) {
  const [data, setData] = useState<{
    settings: TrainingSettings;
    certificationReminders: CertificationReminder[];
    mandatoryTraining: MandatoryTrainingEmployee | null;
    upcomingSessionCount: number;
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void api<NonNullable<typeof data>>("/api/employee/home")
      .then(setData)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "讀取失敗。"));
  }, []);
  return <section>
    <div class="employee-hero">
      <div><p class="eyebrow">MY LEARNING HOME</p><h1>{user.employeeName}，您好</h1><p>這裡是您的必修進度、近期課程與證照提醒。</p></div>
      <div class="hero-progress"><strong>{data?.mandatoryTraining?.completionRate ?? 0}%</strong><span>必修完成率</span></div>
    </div>
    {error && <div class="alert error">{error}</div>}
    <div class="metric-row">
      <div class="metric accent"><span>近期已排課</span><strong>{data?.upcomingSessionCount ?? 0}</strong></div>
      <div class="metric"><span>必修完成</span><strong>{data?.mandatoryTraining?.completedCount ?? 0}/{data?.mandatoryTraining?.requiredCount ?? 0}</strong></div>
      <div class="metric"><span>證照到期提醒</span><strong>{data?.certificationReminders.length ?? 0}</strong></div>
    </div>
    <div class="home-grid">
      <div class="panel">
        <div class="panel-heading"><div><h2>我的證照提醒</h2><small>提前 {data?.settings.certificationReminderDays ?? 60} 天顯示</small></div></div>
        <div class="reminder-list">
          {data?.certificationReminders.map((reminder) => <article class="reminder-card" key={reminder.id} data-certification-id={reminder.id}>
            <div class="reminder-icon">!</div>
            <div><strong>{reminder.certificationName}</strong><p>{reminder.issuer}・到期日 {reminder.expiresAt}</p></div>
            <span class={reminder.daysUntilExpiry <= 30 ? "urgent" : ""}>{expiryText(reminder.daysUntilExpiry)}</span>
          </article>)}
          {data?.certificationReminders.length === 0 && <div class="empty-state">目前沒有即將到期的證照。</div>}
        </div>
      </div>
      <div class="panel">
        <div class="panel-heading"><div><h2>我的必修清單</h2><small>{data?.mandatoryTraining?.jobType}・必修至{LEVEL_LABEL[data?.mandatoryTraining?.requiredLevel ?? 1]}級</small></div></div>
        <div class="course-status-list vertical">{data?.mandatoryTraining?.courses.map((course) => <span class={course.completed ? "completed" : "missing"}>{course.completed ? "✓ 已完成" : "○ 待完成"}・{LEVEL_LABEL[course.competencyLevel]}・{course.courseName}</span>)}</div>
      </div>
    </div>
  </section>;
}

interface MyCertification {
  id: string;
  certificationName: string;
  issuer: string;
  certificateNumber: string | null;
  issuedAt: string;
  expiresAt: string | null;
  notes: string;
  daysUntilExpiry: number | null;
}

export function MyCertifications() {
  const [certifications, setCertifications] = useState<MyCertification[]>([]);
  const [settings, setSettings] = useState<TrainingSettings | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void api<{ certifications: MyCertification[]; settings: TrainingSettings }>("/api/employee/certifications")
      .then((data) => { setCertifications(data.certifications); setSettings(data.settings); })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "讀取失敗。"));
  }, []);
  return <section>
    <div class="page-heading"><div><p class="eyebrow">MY CERTIFICATIONS</p><h1>我的證照</h1><p>查看證號、發證單位與效期；到期前 {settings?.certificationReminderDays ?? 60} 天會在首頁提醒。</p></div></div>
    {error && <div class="alert error">{error}</div>}
    <div class="course-grid">{certifications.map((certification) => <article class="course-card certification-card"><div><span class="status ok">證照</span>{certification.daysUntilExpiry !== null && certification.daysUntilExpiry <= (settings?.certificationReminderDays ?? 60) && <span class="status danger">{expiryText(certification.daysUntilExpiry)}</span>}</div><h2>{certification.certificationName}</h2><p>{certification.issuer}</p><dl><div><dt>證號</dt><dd>{certification.certificateNumber ?? "—"}</dd></div><div><dt>取得日</dt><dd>{certification.issuedAt}</dd></div><div><dt>到期日</dt><dd>{certification.expiresAt ?? "永久"}</dd></div><div><dt>狀態</dt><dd>{certification.daysUntilExpiry === null ? "永久有效" : expiryText(certification.daysUntilExpiry)}</dd></div></dl>{certification.notes && <small>{certification.notes}</small>}</article>)}</div>
    {certifications.length === 0 && <div class="empty-state">目前沒有證照紀錄。</div>}
  </section>;
}
