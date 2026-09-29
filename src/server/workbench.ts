import { ApiError, json, requireEmployeeIdentity } from "./http";
import type { ApiContext, AuthUser } from "./types";
import {
  type EmployeeWorkbenchTarget,
  type WorkbenchItem,
  type WorkbenchSource,
  type WorkbenchSourceState,
  certificationBucket,
  compareWorkbenchItems,
  sessionBucket,
  sourceState,
  taipeiCalendar,
} from "../shared/workbench";

interface OnboardingGapRow {
  applicationId: string;
  itemId: string;
  candidateName: string;
  jobTitle: string;
  applicationStatus: string;
  itemName: string;
}

interface SessionRow {
  enrollmentId: string;
  courseName: string;
  sessionDate: string;
  employeeName?: string;
}

interface CertificationRow {
  id: string;
  certificationName: string;
  expiresAt: string | null;
  employeeName?: string;
}

const ONBOARDING_GAPS_SQL = `
  SELECT ca.id AS applicationId, oi.id AS itemId,
         c.name AS candidateName, jo.title AS jobTitle,
         ca.status AS applicationStatus, oi.name AS itemName
  FROM candidate_applications ca
  JOIN candidates c ON c.id = ca.candidate_id
  JOIN job_openings jo ON jo.id = ca.job_opening_id
  JOIN onboarding_items oi ON oi.active = 1 AND oi.required = 1
  LEFT JOIN application_onboarding_checklist aoc
    ON aoc.application_id = ca.id AND aoc.onboarding_item_id = oi.id
  WHERE ca.status IN ('hired', 'onboarded')
    AND COALESCE(aoc.completed, 0) = 0
  ORDER BY c.name, oi.name
`;

const SESSION_SQL = `
  SELECT en.id AS enrollmentId, c.name AS courseName, cs.session_date AS sessionDate,
         e.name AS employeeName
  FROM enrollments en
  JOIN course_sessions cs ON cs.id = en.course_session_id
  JOIN courses c ON c.id = cs.course_id
  JOIN employees e ON e.id = en.employee_id
  WHERE en.enrollment_status = 'enrolled'
    AND cs.status = 'scheduled'
    AND (? IS NULL OR en.employee_id = ?)
  ORDER BY cs.session_date, c.name, en.id
`;

const CERTIFICATION_SQL = `
  SELECT ec.id, cert.name AS certificationName, ec.expires_at AS expiresAt,
         e.name AS employeeName
  FROM employee_certifications ec
  JOIN certifications cert ON cert.id = ec.certification_id
  JOIN employees e ON e.id = ec.employee_id
  WHERE e.status = 'active'
    AND ec.expires_at IS NOT NULL
    AND (? IS NULL OR ec.employee_id = ?)
  ORDER BY ec.expires_at, e.employee_no, ec.id
`;

function onboardingItem(row: OnboardingGapRow): WorkbenchItem {
  return {
    id: `onboarding_missing:${row.applicationId}:${row.itemId}`,
    source: "onboarding_missing",
    title: `${row.itemName}（${row.candidateName}）`,
    reason: `${row.jobTitle}・狀態 ${row.applicationStatus}・必填文件未完成。系統沒有到職文件截止日，故不排程、也不判逾期。`,
    dueDate: null,
    bucket: "unset",
    nextAction: "到招募管理的到職文件核對並補登",
    target: "recruitment/onboarding",
  };
}

function sessionItem(row: SessionRow, today: string, audience: "admin" | "employee"): WorkbenchItem {
  const bucket = sessionBucket(row.sessionDate, today);
  const past = bucket === "past_unconfirmed";
  const who = audience === "admin" && row.employeeName ? `${row.employeeName}・` : "";
  return {
    id: `course_session:${row.enrollmentId}`,
    source: "course_session",
    title: row.courseName,
    reason: past
      ? `${who}場次 ${row.sessionDate} 已過、待核對。這不是缺席判斷，只表示排定場次日已早於今天且尚未結案。`
      : `${who}已報名或指派的排定場次，日期 ${row.sessionDate}。`,
    dueDate: isStoredDate(row.sessionDate) ? row.sessionDate : null,
    bucket,
    nextAction: audience === "admin" ? "到排課的出席登錄核對此場次" : "到我的課表核對此場次",
    target: audience === "admin" ? "scheduling/attendance" : "schedule",
  };
}

function certificationItem(
  row: CertificationRow,
  today: string,
  audience: "admin" | "employee",
): WorkbenchItem | null {
  const bucket = certificationBucket(row.expiresAt, today);
  if (bucket === null) return null;
  const who = audience === "admin" && row.employeeName ? `${row.employeeName}・` : "";
  const dueDate = row.expiresAt !== null && isStoredDate(row.expiresAt) ? row.expiresAt : null;
  return {
    id: `certification_expiry:${row.id}`,
    source: "certification_expiry",
    title: row.certificationName,
    reason: dueDate === null
      ? `${who}到期日無法解讀為日期，需待補資料，不視為正常也未排除。`
      : `${who}既有證照到期日 ${dueDate}。`,
    dueDate,
    bucket,
    nextAction: audience === "admin" ? "到健康與證照的證照管理核對" : "到我的證照核對效期",
    target: audience === "admin" ? "health/certifications" : "certifications",
  };
}

function isStoredDate(value: string): boolean {
  return /^(\d{4})-(\d{2})-(\d{2})$/.test(value);
}

async function loadRows(
  db: D1Database,
  employeeId: string | null,
): Promise<{
  items: WorkbenchItem[];
  sources: Record<WorkbenchSource, WorkbenchSourceState>;
  calendar: ReturnType<typeof taipeiCalendar>;
}> {
  const calendar = taipeiCalendar();
  const employeeBinding = employeeId ?? null;
  const [onboarding, sessions, certifications] = await Promise.all([
    employeeId
      ? Promise.resolve({ results: [] as OnboardingGapRow[] })
      : db.prepare(ONBOARDING_GAPS_SQL).all<OnboardingGapRow>(),
    db.prepare(SESSION_SQL).bind(employeeBinding, employeeBinding).all<SessionRow>(),
    db.prepare(CERTIFICATION_SQL).bind(employeeBinding, employeeBinding).all<CertificationRow>(),
  ]);
  const audience = employeeId ? "employee" : "admin";
  const items = [
    ...onboarding.results.map(onboardingItem),
    ...sessions.results.map((row) => sessionItem(row, calendar.today, audience)),
    ...certifications.results.flatMap((row) => {
      const item = certificationItem(row, calendar.today, audience);
      return item ? [item] : [];
    }),
  ].sort(compareWorkbenchItems);
  if (employeeId) {
    for (const item of items) {
      if (item.target !== "schedule" && item.target !== "certifications") {
        throw new ApiError(500, "員工工作台產生了不允許的導覽目標。");
      }
    }
  }
  return {
    items,
    sources: {
      onboarding_missing: employeeId
        ? { status: "ok", itemCount: 0, message: "員工工作台不包含到職缺件。" }
        : sourceState(items, "onboarding_missing"),
      course_session: sourceState(items, "course_session"),
      certification_expiry: sourceState(items, "certification_expiry"),
    },
    calendar,
  };
}

export async function adminWorkbench(context: ApiContext): Promise<Response> {
  if (context.url.searchParams.has("employeeId")) {
    throw new ApiError(400, "工作台不接受 employeeId 查詢參數。");
  }
  const loaded = await loadRows(context.env.DB, null);
  return json({
    timezone: "Asia/Taipei",
    ...loaded.calendar,
    items: loaded.items,
    sources: loaded.sources,
    note: "日期分組只用於工作台呈現，不建立到職截止日、缺席或強制重訓政策。",
  });
}

export async function employeeWorkbench(
  context: ApiContext,
  user: AuthUser & { employeeId: string },
): Promise<Response> {
  if (context.url.searchParams.has("employeeId")) {
    throw new ApiError(400, "工作台不接受 employeeId 查詢參數。");
  }
  const loaded = await loadRows(context.env.DB, user.employeeId);
  const items = loaded.items.filter(
    (item): item is WorkbenchItem & { target: EmployeeWorkbenchTarget } =>
      item.target === "schedule" || item.target === "certifications",
  );
  return json({
    timezone: "Asia/Taipei",
    ...loaded.calendar,
    items,
    sources: loaded.sources,
    note: "只含本人已報名或指派場次與本人證照。日期分組不是缺席或重訓政策。",
  });
}

export async function handleAdminWorkbench(context: ApiContext, path: string): Promise<Response | null> {
  if (path === "/api/admin/workbench" && context.request.method === "GET") {
    return adminWorkbench(context);
  }
  return null;
}

export async function handleEmployeeWorkbench(context: ApiContext, path: string): Promise<Response | null> {
  if (path === "/api/employee/workbench" && context.request.method === "GET") {
    const user = requireEmployeeIdentity(context.user);
    if (user.role !== "employee") throw new ApiError(403, "您沒有執行此操作的權限。");
    return employeeWorkbench(context, user);
  }
  return null;
}
