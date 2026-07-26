import {
  ApiError,
  json,
  optionalString,
  parseJson,
  requireAdmin,
  requiredString,
  uuid,
} from "./http";
import type { ApiContext, AuthUser } from "./types";

const PIPELINE_STAGES = [
  "applied",
  "screening",
  "interview",
  "salary_approval",
  "offer",
  "hired",
  "onboarded",
] as const;

type PipelineStage = (typeof PIPELINE_STAGES)[number];
type ApplicationStatus = PipelineStage | "rejected";

const NEXT_STATUS: Record<PipelineStage, ApplicationStatus[]> = {
  applied: ["screening", "rejected"],
  screening: ["interview", "rejected"],
  interview: ["salary_approval", "rejected"],
  salary_approval: ["offer", "rejected"],
  offer: ["hired", "rejected"],
  hired: ["onboarded", "rejected"],
  onboarded: [],
};

const STAGE_LABELS: Record<PipelineStage, string> = {
  applied: "投遞",
  screening: "篩選",
  interview: "面試",
  salary_approval: "核薪",
  offer: "發送錄取",
  hired: "錄取",
  onboarded: "到職",
};

interface JobOpeningInput {
  title?: unknown;
  department?: unknown;
  headcount?: unknown;
  description?: unknown;
  status?: unknown;
}

interface CandidateInput {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  source?: unknown;
  resumeUrl?: unknown;
  notes?: unknown;
}

interface ApplicationInput {
  jobOpeningId?: unknown;
}

interface TransitionInput {
  status?: unknown;
  note?: unknown;
}

interface InterviewInput {
  applicationId?: unknown;
  roundNumber?: unknown;
  scheduledAt?: unknown;
  interviewerName?: unknown;
  location?: unknown;
  status?: unknown;
  notes?: unknown;
}

interface InterviewScoresInput {
  scores?: unknown;
}

interface SalaryApprovalInput {
  expectedSalary?: unknown;
  suggestedSalary?: unknown;
  approvedSalary?: unknown;
  compensationNotes?: unknown;
  status?: unknown;
}

interface OfferInput {
  status?: unknown;
  noticeText?: unknown;
}

interface OnboardingItemInput {
  name?: unknown;
  required?: unknown;
  active?: unknown;
}

interface ChecklistInput {
  completed?: unknown;
  notes?: unknown;
}

interface ProbationInput {
  employeeId?: unknown;
  candidateApplicationId?: unknown;
  startDate?: unknown;
  durationDays?: unknown;
  result?: unknown;
  notes?: unknown;
}

interface ProbationSettingsInput {
  reminderDays?: unknown;
}

interface ApplicationRow {
  id: string;
  candidateId: string;
  candidateName: string;
  candidateEmail: string | null;
  candidatePhone: string | null;
  source: string;
  resumeUrl: string | null;
  candidateNotes: string;
  jobOpeningId: string;
  jobTitle: string;
  department: string;
  openingStatus: string;
  status: ApplicationStatus;
  appliedAt: string;
  updatedAt: string;
}

interface ProbationReminderRow {
  id: string;
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  department: string;
  candidateApplicationId: string | null;
  startDate: string;
  durationDays: number;
  dueDate: string;
  result: string | null;
  notes: string;
  daysUntilDue: number;
}

const APPLICATION_SELECT = `
  SELECT ca.id, ca.candidate_id AS candidateId, c.name AS candidateName,
         c.email AS candidateEmail, c.phone AS candidatePhone, c.source,
         c.resume_url AS resumeUrl, c.notes AS candidateNotes,
         ca.job_opening_id AS jobOpeningId, jo.title AS jobTitle,
         jo.department, jo.status AS openingStatus, ca.status,
         ca.applied_at AS appliedAt, ca.updated_at AS updatedAt
  FROM candidate_applications ca
  JOIN candidates c ON c.id = ca.candidate_id
  JOIN job_openings jo ON jo.id = ca.job_opening_id
`;

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ApiError(422, `${label}須為 ${min}～${max} 的整數。`);
  }
  return value;
}

function nullableMoney(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  return integer(value, label, 0, 100_000_000);
}

function nullableId(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, label, 100);
}

function booleanValue(value: unknown, label: string, fallback?: boolean): boolean {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "boolean") throw new ApiError(422, `${label}格式不正確。`);
  return value;
}

function isoDate(value: unknown, label: string): string {
  const date = requiredString(value, label, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new ApiError(422, `${label}格式須為 YYYY-MM-DD。`);
  }
  return date;
}

function isoDateTime(value: unknown, label: string): string {
  const text = requiredString(value, label, 40);
  const timestamp = Date.parse(text);
  if (Number.isNaN(timestamp)) throw new ApiError(422, `${label}格式不正確。`);
  return new Date(timestamp).toISOString();
}

function dueDate(startDate: string, durationDays: number): string {
  const date = new Date(`${startDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + durationDays);
  return date.toISOString().slice(0, 10);
}

function jobOpeningStatus(value: unknown): "open" | "paused" | "closed" {
  if (value === "open" || value === "paused" || value === "closed") return value;
  throw new ApiError(422, "職缺狀態必須是開放、暫停或關閉。");
}

function applicationStatus(value: unknown): ApplicationStatus {
  if (value === "rejected" || PIPELINE_STAGES.includes(value as PipelineStage)) {
    return value as ApplicationStatus;
  }
  throw new ApiError(422, "候選人階段不正確。");
}

function parseJobOpening(body: JobOpeningInput) {
  return {
    title: requiredString(body.title, "職稱", 200),
    department: requiredString(body.department, "部門", 200),
    headcount: integer(body.headcount, "需求人數", 1, 1000),
    description: requiredString(body.description, "職務說明", 10_000),
    status: jobOpeningStatus(body.status),
  };
}

function parseCandidate(body: CandidateInput) {
  const email = optionalString(body.email, "Email", 320);
  const phone = optionalString(body.phone, "電話", 100);
  if (!email && !phone) throw new ApiError(422, "Email 與電話至少須填一項。");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(422, "Email 格式不正確。");
  }
  return {
    name: requiredString(body.name, "姓名", 200),
    email,
    phone,
    source: requiredString(body.source, "來源", 200),
    resumeUrl: optionalString(body.resumeUrl, "履歷連結", 2000),
    notes: optionalString(body.notes, "備註", 5000),
  };
}

async function applicationById(db: D1Database, id: string): Promise<ApplicationRow> {
  const application = await db.prepare(
    `${APPLICATION_SELECT} WHERE ca.id = ?`,
  ).bind(id).first<ApplicationRow>();
  if (!application) throw new ApiError(404, "找不到指定應徵紀錄。");
  return application;
}

async function listJobOpenings(context: ApiContext): Promise<Response> {
  const result = await context.env.DB.prepare(`
    SELECT jo.id, jo.title, jo.department, jo.headcount, jo.description, jo.status,
           jo.created_at AS createdAt, jo.updated_at AS updatedAt,
           COUNT(ca.id) AS applicationCount,
           SUM(CASE WHEN ca.status = 'onboarded' THEN 1 ELSE 0 END) AS onboardedCount
    FROM job_openings jo
    LEFT JOIN candidate_applications ca ON ca.job_opening_id = jo.id
    GROUP BY jo.id
    ORDER BY CASE jo.status WHEN 'open' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
             jo.updated_at DESC
  `).all();
  return json({ jobOpenings: result.results });
}

async function createJobOpening(context: ApiContext): Promise<Response> {
  const opening = parseJobOpening(await parseJson<JobOpeningInput>(context.request));
  const id = uuid();
  await context.env.DB.prepare(`
    INSERT INTO job_openings (id, title, department, headcount, description, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    opening.title,
    opening.department,
    opening.headcount,
    opening.description,
    opening.status,
  ).run();
  return json({ id, ...opening }, 201);
}

async function updateJobOpening(context: ApiContext, id: string): Promise<Response> {
  const opening = parseJobOpening(await parseJson<JobOpeningInput>(context.request));
  const result = await context.env.DB.prepare(`
    UPDATE job_openings
    SET title = ?, department = ?, headcount = ?, description = ?, status = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).bind(
    opening.title,
    opening.department,
    opening.headcount,
    opening.description,
    opening.status,
    id,
  ).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定職缺。");
  return json({ id, ...opening });
}

async function deleteJobOpening(context: ApiContext, id: string): Promise<Response> {
  try {
    const result = await context.env.DB.prepare("DELETE FROM job_openings WHERE id = ?").bind(id).run();
    if (result.meta.changes === 0) throw new ApiError(404, "找不到指定職缺。");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(409, "此職缺已有應徵紀錄，請改為關閉而非刪除。");
  }
  return json({ id, deleted: true });
}

async function listCandidates(context: ApiContext): Promise<Response> {
  const search = context.url.searchParams.get("search")?.trim() ?? "";
  const openingId = context.url.searchParams.get("jobOpeningId")?.trim() ?? "";
  const statusQuery = context.url.searchParams.get("status")?.trim() ?? "";
  const filters: string[] = [];
  const bindings: string[] = [];
  if (search) {
    filters.push(`(
      c.name LIKE ? OR COALESCE(c.email, '') LIKE ? OR COALESCE(c.phone, '') LIKE ?
      OR c.source LIKE ? OR COALESCE(c.resume_url, '') LIKE ? OR c.notes LIKE ?
    )`);
    const pattern = `%${search}%`;
    bindings.push(pattern, pattern, pattern, pattern, pattern, pattern);
  }
  if (openingId) {
    filters.push("EXISTS (SELECT 1 FROM candidate_applications f WHERE f.candidate_id = c.id AND f.job_opening_id = ?)");
    bindings.push(openingId);
  }
  if (statusQuery) {
    const status = applicationStatus(statusQuery);
    filters.push("EXISTS (SELECT 1 FROM candidate_applications f WHERE f.candidate_id = c.id AND f.status = ?)");
    bindings.push(status);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const candidates = await context.env.DB.prepare(`
    SELECT c.id, c.name, c.email, c.phone, c.source, c.resume_url AS resumeUrl,
           c.notes, c.created_at AS createdAt, c.updated_at AS updatedAt
    FROM candidates c
    ${where}
    ORDER BY c.updated_at DESC, c.name
  `).bind(...bindings).all<{
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    source: string;
    resumeUrl: string | null;
    notes: string;
    createdAt: string;
    updatedAt: string;
  }>();
  if (candidates.results.length === 0) return json({ candidates: [] });
  const placeholders = candidates.results.map(() => "?").join(", ");
  const applications = await context.env.DB.prepare(`
    ${APPLICATION_SELECT}
    WHERE ca.candidate_id IN (${placeholders})
    ORDER BY ca.updated_at DESC
  `).bind(...candidates.results.map((candidate) => candidate.id)).all<ApplicationRow>();
  return json({
    candidates: candidates.results.map((candidate) => ({
      ...candidate,
      applications: applications.results.filter(
        (application) => application.candidateId === candidate.id,
      ),
    })),
  });
}

async function candidateDetail(context: ApiContext, id: string): Promise<Response> {
  const candidate = await context.env.DB.prepare(`
    SELECT id, name, email, phone, source, resume_url AS resumeUrl, notes,
           created_at AS createdAt, updated_at AS updatedAt
    FROM candidates WHERE id = ?
  `).bind(id).first();
  if (!candidate) throw new ApiError(404, "找不到指定候選人。");
  const applications = await context.env.DB.prepare(`
    ${APPLICATION_SELECT} WHERE ca.candidate_id = ? ORDER BY ca.updated_at DESC
  `).bind(id).all<ApplicationRow>();
  return json({ candidate: { ...candidate, applications: applications.results } });
}

async function createCandidate(context: ApiContext): Promise<Response> {
  const candidate = parseCandidate(await parseJson<CandidateInput>(context.request));
  const id = uuid();
  await context.env.DB.prepare(`
    INSERT INTO candidates (
      id, name, email, phone, source, resume_url, notes, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'applied')
  `).bind(
    id,
    candidate.name,
    candidate.email || null,
    candidate.phone || null,
    candidate.source,
    candidate.resumeUrl || null,
    candidate.notes,
  ).run();
  return json({ id, ...candidate }, 201);
}

async function updateCandidate(context: ApiContext, id: string): Promise<Response> {
  const candidate = parseCandidate(await parseJson<CandidateInput>(context.request));
  const result = await context.env.DB.prepare(`
    UPDATE candidates
    SET name = ?, email = ?, phone = ?, source = ?, resume_url = ?, notes = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).bind(
    candidate.name,
    candidate.email || null,
    candidate.phone || null,
    candidate.source,
    candidate.resumeUrl || null,
    candidate.notes,
    id,
  ).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定候選人。");
  return json({ id, ...candidate });
}

async function deleteCandidate(context: ApiContext, id: string): Promise<Response> {
  const result = await context.env.DB.prepare("DELETE FROM candidates WHERE id = ?").bind(id).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定候選人。");
  return json({ id, deleted: true });
}

async function listApplications(context: ApiContext): Promise<Response> {
  const openingId = context.url.searchParams.get("jobOpeningId");
  const statusQuery = context.url.searchParams.get("status");
  const filters: string[] = [];
  const bindings: string[] = [];
  if (openingId) {
    filters.push("ca.job_opening_id = ?");
    bindings.push(openingId);
  }
  if (statusQuery) {
    filters.push("ca.status = ?");
    bindings.push(applicationStatus(statusQuery));
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const result = await context.env.DB.prepare(`
    ${APPLICATION_SELECT}
    ${where}
    ORDER BY ca.updated_at DESC
  `).bind(...bindings).all<ApplicationRow>();
  return json({ applications: result.results });
}

async function createApplication(
  context: ApiContext,
  admin: AuthUser,
  candidateId: string,
): Promise<Response> {
  const body = await parseJson<ApplicationInput>(context.request);
  const jobOpeningId = requiredString(body.jobOpeningId, "職缺", 100);
  const [candidate, opening] = await Promise.all([
    context.env.DB.prepare("SELECT id FROM candidates WHERE id = ?").bind(candidateId).first(),
    context.env.DB.prepare("SELECT id, status FROM job_openings WHERE id = ?")
      .bind(jobOpeningId).first<{ id: string; status: string }>(),
  ]);
  if (!candidate) throw new ApiError(404, "找不到指定候選人。");
  if (!opening) throw new ApiError(404, "找不到指定職缺。");
  if (opening.status !== "open") throw new ApiError(409, "只有開放中的職缺可新增應徵紀錄。");
  const id = uuid();
  try {
    await context.env.DB.batch([
      context.env.DB.prepare(`
        INSERT INTO candidate_applications (id, candidate_id, job_opening_id, status)
        VALUES (?, ?, ?, 'applied')
      `).bind(id, candidateId, jobOpeningId),
      context.env.DB.prepare(`
        INSERT INTO candidate_application_status_history (
          id, application_id, from_status, to_status, changed_by, note
        ) VALUES (?, ?, NULL, 'applied', ?, '建立應徵紀錄')
      `).bind(uuid(), id, admin.id),
    ]);
  } catch {
    throw new ApiError(409, "此候選人已應徵過該職缺。");
  }
  return json({ id, candidateId, jobOpeningId, status: "applied" }, 201);
}

async function deleteApplication(context: ApiContext, id: string): Promise<Response> {
  const application = await applicationById(context.env.DB, id);
  if (application.status !== "applied" && application.status !== "rejected") {
    throw new ApiError(409, "只有投遞或已淘汰的應徵紀錄可刪除。");
  }
  await context.env.DB.prepare("DELETE FROM candidate_applications WHERE id = ?").bind(id).run();
  return json({ id, deleted: true });
}

async function assertTransitionRequirements(
  db: D1Database,
  application: ApplicationRow,
  target: ApplicationStatus,
): Promise<void> {
  if (application.status === "interview" && target === "salary_approval") {
    const score = await db.prepare(`
      SELECT COUNT(*) AS count
      FROM interviews i
      JOIN interview_scores s ON s.interview_id = i.id
      WHERE i.application_id = ? AND i.status = 'completed'
    `).bind(application.id).first<{ count: number }>();
    if ((score?.count ?? 0) === 0) {
      throw new ApiError(409, "至少須完成一輪面試並登錄評分，才能進入核薪。");
    }
  }
  if (application.status === "salary_approval" && target === "offer") {
    const approval = await db.prepare(`
      SELECT approved_salary AS approvedSalary, status
      FROM salary_approvals WHERE application_id = ?
    `).bind(application.id).first<{ approvedSalary: number | null; status: string }>();
    if (!approval || approval.status !== "approved" || approval.approvedSalary === null) {
      throw new ApiError(409, "核薪須完成核定薪資並核准，才能發送錄取通知。");
    }
  }
  if (application.status === "offer" && target === "hired") {
    const offer = await db.prepare(`
      SELECT status FROM recruitment_offers WHERE application_id = ?
    `).bind(application.id).first<{ status: string }>();
    if (offer?.status !== "accepted") {
      throw new ApiError(409, "候選人接受錄取通知後，才能標記為錄取。");
    }
  }
  if (application.status === "hired" && target === "onboarded") {
    const missing = await db.prepare(`
      SELECT COUNT(*) AS count
      FROM onboarding_items oi
      LEFT JOIN application_onboarding_checklist aoc
        ON aoc.onboarding_item_id = oi.id AND aoc.application_id = ?
      WHERE oi.active = 1 AND oi.required = 1 AND COALESCE(aoc.completed, 0) = 0
    `).bind(application.id).first<{ count: number }>();
    if ((missing?.count ?? 0) > 0) {
      throw new ApiError(409, "必填到職文件尚未全部完成，無法標記到職。");
    }
  }
}

async function transitionApplication(
  context: ApiContext,
  admin: AuthUser,
  id: string,
): Promise<Response> {
  const body = await parseJson<TransitionInput>(context.request);
  const target = applicationStatus(body.status);
  const note = optionalString(body.note, "狀態備註", 2000);
  const application = await applicationById(context.env.DB, id);
  if (application.status === "rejected" || application.status === "onboarded") {
    throw new ApiError(409, "此應徵流程已結束，無法再變更階段。");
  }
  if (!NEXT_STATUS[application.status].includes(target)) {
    throw new ApiError(
      409,
      `不可由「${application.status}」直接轉為「${target}」，請依招募流程逐步操作。`,
    );
  }
  await assertTransitionRequirements(context.env.DB, application, target);
  await context.env.DB.batch([
    context.env.DB.prepare(`
      UPDATE candidate_applications
      SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND status = ?
    `).bind(target, id, application.status),
    context.env.DB.prepare(`
      INSERT INTO candidate_application_status_history (
        id, application_id, from_status, to_status, changed_by, note
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(uuid(), id, application.status, target, admin.id, note),
  ]);
  return json({ id, fromStatus: application.status, status: target });
}

async function applicationHistory(context: ApiContext, id: string): Promise<Response> {
  await applicationById(context.env.DB, id);
  const result = await context.env.DB.prepare(`
    SELECT h.id, h.from_status AS fromStatus, h.to_status AS toStatus,
           h.note, h.changed_at AS changedAt, u.email AS changedBy
    FROM candidate_application_status_history h
    JOIN users u ON u.id = h.changed_by
    WHERE h.application_id = ?
    ORDER BY h.changed_at, h.rowid
  `).bind(id).all();
  return json({ history: result.results });
}

/** M4 報表以部門與投遞期間篩選漏斗；未帶篩選時等同 M3 原本的全量統計。 */
export interface FunnelFilters {
  department?: string | null;
  /** 依應徵投遞時間（applied_at）界定期間，起日含、迄日不含。 */
  appliedFrom?: string | null;
  appliedBefore?: string | null;
}

export interface FunnelStage {
  stage: PipelineStage;
  label: string;
  currentCount: number;
  enteredCount: number;
}

export interface FunnelResult {
  stages: FunnelStage[];
  rejectedCount: number;
}

export async function funnelData(db: D1Database, filters: FunnelFilters = {}): Promise<FunnelResult> {
  const conditions: string[] = [];
  const bindings: string[] = [];
  if (filters.department) {
    conditions.push("jo.department = ?");
    bindings.push(filters.department);
  }
  if (filters.appliedFrom) {
    conditions.push("ca.applied_at >= ?");
    bindings.push(filters.appliedFrom);
  }
  if (filters.appliedBefore) {
    conditions.push("ca.applied_at < ?");
    bindings.push(filters.appliedBefore);
  }
  const scope = conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : "";
  const source = `
    FROM candidate_applications ca
    JOIN job_openings jo ON jo.id = ca.job_opening_id
  `;
  const [current, entered, rejected] = await Promise.all([
    db.prepare(`
      SELECT ca.status, COUNT(*) AS count
      ${source}
      WHERE ca.status <> 'rejected'${scope}
      GROUP BY ca.status
    `).bind(...bindings).all<{ status: PipelineStage; count: number }>(),
    db.prepare(`
      SELECT h.to_status AS status, COUNT(DISTINCT h.application_id) AS count
      FROM candidate_application_status_history h
      JOIN candidate_applications ca ON ca.id = h.application_id
      JOIN job_openings jo ON jo.id = ca.job_opening_id
      WHERE h.to_status <> 'rejected'${scope}
      GROUP BY h.to_status
    `).bind(...bindings).all<{ status: PipelineStage; count: number }>(),
    db.prepare(`
      SELECT COUNT(*) AS count
      ${source}
      WHERE ca.status = 'rejected'${scope}
    `).bind(...bindings).first<{ count: number }>(),
  ]);
  const currentCounts = new Map(current.results.map((row) => [row.status, row.count]));
  const enteredCounts = new Map(entered.results.map((row) => [row.status, row.count]));
  return {
    stages: PIPELINE_STAGES.map((stage) => ({
      stage,
      label: STAGE_LABELS[stage],
      currentCount: currentCounts.get(stage) ?? 0,
      enteredCount: enteredCounts.get(stage) ?? 0,
    })),
    rejectedCount: rejected?.count ?? 0,
  };
}

async function funnelStats(context: ApiContext): Promise<Response> {
  return json(await funnelData(context.env.DB));
}

function parseInterview(body: InterviewInput) {
  const status = body.status === "scheduled" || body.status === "completed" || body.status === "cancelled"
    ? body.status
    : null;
  if (!status) throw new ApiError(422, "面試狀態不正確。");
  return {
    applicationId: requiredString(body.applicationId, "應徵紀錄", 100),
    roundNumber: integer(body.roundNumber, "面試輪次", 1, 20),
    scheduledAt: isoDateTime(body.scheduledAt, "面試時間"),
    interviewerName: requiredString(body.interviewerName, "面試官", 200),
    location: optionalString(body.location, "面試地點", 500),
    status,
    notes: optionalString(body.notes, "面試備註", 3000),
  };
}

async function listInterviews(context: ApiContext): Promise<Response> {
  const applicationId = context.url.searchParams.get("applicationId");
  const where = applicationId ? "WHERE i.application_id = ?" : "";
  const statement = context.env.DB.prepare(`
    SELECT i.id, i.application_id AS applicationId, i.round_number AS roundNumber,
           i.scheduled_at AS scheduledAt, i.interviewer_name AS interviewerName,
           i.location, i.status, i.notes, ca.status AS applicationStatus,
           c.id AS candidateId, c.name AS candidateName,
           jo.id AS jobOpeningId, jo.title AS jobTitle,
           COUNT(s.id) AS scoreCount, ROUND(AVG(s.score), 2) AS averageScore
    FROM interviews i
    JOIN candidate_applications ca ON ca.id = i.application_id
    JOIN candidates c ON c.id = ca.candidate_id
    JOIN job_openings jo ON jo.id = ca.job_opening_id
    LEFT JOIN interview_scores s ON s.interview_id = i.id
    ${where}
    GROUP BY i.id
    ORDER BY i.scheduled_at DESC, i.round_number DESC
  `);
  const interviews = applicationId
    ? await statement.bind(applicationId).all()
    : await statement.all();
  const scores = await context.env.DB.prepare(`
    SELECT id, interview_id AS interviewId, dimension, score, comments
    FROM interview_scores ORDER BY dimension
  `).all<{ id: string; interviewId: string; dimension: string; score: number; comments: string }>();
  return json({
    interviews: interviews.results.map((interview) => ({
      ...interview,
      scores: scores.results.filter((score) => score.interviewId === (interview as { id: string }).id),
    })),
  });
}

async function createInterview(context: ApiContext): Promise<Response> {
  const interview = parseInterview(await parseJson<InterviewInput>(context.request));
  await applicationById(context.env.DB, interview.applicationId);
  const id = uuid();
  try {
    await context.env.DB.prepare(`
      INSERT INTO interviews (
        id, candidate_id, application_id, round_number, scheduled_at,
        interviewer_name, location, status, notes
      )
      SELECT ?, candidate_id, id, ?, ?, ?, ?, ?, ?
      FROM candidate_applications WHERE id = ?
    `).bind(
      id,
      interview.roundNumber,
      interview.scheduledAt,
      interview.interviewerName,
      interview.location || null,
      interview.status,
      interview.notes,
      interview.applicationId,
    ).run();
  } catch {
    throw new ApiError(409, "此應徵紀錄已有相同輪次的面試。");
  }
  return json({ id, ...interview }, 201);
}

async function updateInterview(context: ApiContext, id: string): Promise<Response> {
  const interview = parseInterview(await parseJson<InterviewInput>(context.request));
  await applicationById(context.env.DB, interview.applicationId);
  try {
    const result = await context.env.DB.prepare(`
      UPDATE interviews
      SET candidate_id = (SELECT candidate_id FROM candidate_applications WHERE id = ?),
          application_id = ?, round_number = ?, scheduled_at = ?,
          interviewer_name = ?, location = ?, status = ?, notes = ?
      WHERE id = ?
    `).bind(
      interview.applicationId,
      interview.applicationId,
      interview.roundNumber,
      interview.scheduledAt,
      interview.interviewerName,
      interview.location || null,
      interview.status,
      interview.notes,
      id,
    ).run();
    if (result.meta.changes === 0) throw new ApiError(404, "找不到指定面試。");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(409, "此應徵紀錄已有相同輪次的面試。");
  }
  return json({ id, ...interview });
}

async function deleteInterview(context: ApiContext, id: string): Promise<Response> {
  const result = await context.env.DB.prepare("DELETE FROM interviews WHERE id = ?").bind(id).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定面試。");
  return json({ id, deleted: true });
}

async function saveInterviewScores(context: ApiContext, id: string): Promise<Response> {
  const body = await parseJson<InterviewScoresInput>(context.request);
  if (!Array.isArray(body.scores) || body.scores.length === 0) {
    throw new ApiError(422, "請至少提供一項面試評分。");
  }
  const scores = body.scores.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ApiError(422, "面試評分格式不正確。");
    }
    const item = value as { dimension?: unknown; score?: unknown; comments?: unknown };
    return {
      dimension: requiredString(item.dimension, "評分面向", 200),
      score: integer(item.score, "面試分數", 1, 5),
      comments: optionalString(item.comments, "評語", 2000),
    };
  });
  if (new Set(scores.map((score) => score.dimension)).size !== scores.length) {
    throw new ApiError(422, "評分面向不可重複。");
  }
  const interview = await context.env.DB.prepare(
    "SELECT id FROM interviews WHERE id = ?",
  ).bind(id).first();
  if (!interview) throw new ApiError(404, "找不到指定面試。");
  await context.env.DB.batch([
    context.env.DB.prepare("DELETE FROM interview_scores WHERE interview_id = ?").bind(id),
    ...scores.map((score) => context.env.DB.prepare(`
      INSERT INTO interview_scores (id, interview_id, dimension, score, comments)
      VALUES (?, ?, ?, ?, ?)
    `).bind(uuid(), id, score.dimension, score.score, score.comments)),
  ]);
  return json({ interviewId: id, scores });
}

async function listSalaryApprovals(context: ApiContext): Promise<Response> {
  const result = await context.env.DB.prepare(`
    SELECT sa.id, sa.application_id AS applicationId,
           sa.expected_salary AS expectedSalary,
           sa.suggested_salary AS suggestedSalary,
           sa.approved_salary AS approvedSalary,
           sa.compensation_notes AS compensationNotes, sa.status,
           sa.approved_at AS approvedAt, sa.created_at AS createdAt,
           sa.updated_at AS updatedAt, c.name AS candidateName,
           jo.title AS jobTitle, jo.department, ca.status AS applicationStatus
    FROM salary_approvals sa
    JOIN candidate_applications ca ON ca.id = sa.application_id
    JOIN candidates c ON c.id = ca.candidate_id
    JOIN job_openings jo ON jo.id = ca.job_opening_id
    ORDER BY sa.updated_at DESC
  `).all();
  return json({ salaryApprovals: result.results });
}

async function saveSalaryApproval(
  context: ApiContext,
  admin: AuthUser,
  applicationId: string,
): Promise<Response> {
  const body = await parseJson<SalaryApprovalInput>(context.request);
  await applicationById(context.env.DB, applicationId);
  const status = body.status === "draft"
    || body.status === "submitted"
    || body.status === "approved"
    || body.status === "rejected"
    ? body.status
    : null;
  if (!status) throw new ApiError(422, "核薪狀態不正確。");
  const salary = {
    expectedSalary: nullableMoney(body.expectedSalary, "期望薪資"),
    suggestedSalary: nullableMoney(body.suggestedSalary, "建議薪資"),
    approvedSalary: nullableMoney(body.approvedSalary, "核定薪資"),
    compensationNotes: optionalString(body.compensationNotes, "薪酬說明", 5000),
    status,
  };
  if (status === "approved" && salary.approvedSalary === null) {
    throw new ApiError(422, "核准時必須填寫核定薪資。");
  }
  const existing = await context.env.DB.prepare(
    "SELECT id FROM salary_approvals WHERE application_id = ?",
  ).bind(applicationId).first<{ id: string }>();
  const id = existing?.id ?? uuid();
  await context.env.DB.prepare(`
    INSERT INTO salary_approvals (
      id, application_id, expected_salary, suggested_salary, approved_salary,
      compensation_notes, status, approved_by, approved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(application_id) DO UPDATE SET
      expected_salary = excluded.expected_salary,
      suggested_salary = excluded.suggested_salary,
      approved_salary = excluded.approved_salary,
      compensation_notes = excluded.compensation_notes,
      status = excluded.status,
      approved_by = excluded.approved_by,
      approved_at = excluded.approved_at,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).bind(
    id,
    applicationId,
    salary.expectedSalary,
    salary.suggestedSalary,
    salary.approvedSalary,
    salary.compensationNotes,
    salary.status,
    salary.status === "approved" ? admin.id : null,
    salary.status === "approved" ? new Date().toISOString() : null,
  ).run();
  return json({ id, applicationId, ...salary });
}

async function deleteSalaryApproval(context: ApiContext, applicationId: string): Promise<Response> {
  const result = await context.env.DB.prepare(
    "DELETE FROM salary_approvals WHERE application_id = ?",
  ).bind(applicationId).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定核薪紀錄。");
  return json({ applicationId, deleted: true });
}

async function offerTemplate(db: D1Database, applicationId: string): Promise<string> {
  const detail = await db.prepare(`
    SELECT c.name AS candidateName, jo.title AS jobTitle, jo.department,
           sa.approved_salary AS approvedSalary
    FROM candidate_applications ca
    JOIN candidates c ON c.id = ca.candidate_id
    JOIN job_openings jo ON jo.id = ca.job_opening_id
    LEFT JOIN salary_approvals sa ON sa.application_id = ca.id
    WHERE ca.id = ?
  `).bind(applicationId).first<{
    candidateName: string;
    jobTitle: string;
    department: string;
    approvedSalary: number | null;
  }>();
  if (!detail) throw new ApiError(404, "找不到指定應徵紀錄。");
  const salary = detail.approvedSalary === null
    ? "薪資條件請參閱附件或與 HR 聯繫"
    : `核定月薪：新台幣 ${detail.approvedSalary.toLocaleString("zh-TW")} 元`;
  return `${detail.candidateName} 您好：

很高興通知您錄取本公司「${detail.department}－${detail.jobTitle}」職務。
${salary}

請回覆此通知確認是否接受錄取，並與 HR 約定報到日期及準備到職文件。

期待您的加入！
人力資源部`;
}

async function listOffers(context: ApiContext): Promise<Response> {
  const result = await context.env.DB.prepare(`
    SELECT ro.id, ro.application_id AS applicationId, ro.status,
           ro.notice_text AS noticeText, ro.sent_at AS sentAt,
           ro.responded_at AS respondedAt, ro.created_at AS createdAt,
           ro.updated_at AS updatedAt, c.name AS candidateName,
           jo.title AS jobTitle, jo.department, ca.status AS applicationStatus,
           sa.approved_salary AS approvedSalary
    FROM recruitment_offers ro
    JOIN candidate_applications ca ON ca.id = ro.application_id
    JOIN candidates c ON c.id = ca.candidate_id
    JOIN job_openings jo ON jo.id = ca.job_opening_id
    LEFT JOIN salary_approvals sa ON sa.application_id = ca.id
    ORDER BY ro.updated_at DESC
  `).all();
  return json({ offers: result.results });
}

async function getOfferTemplate(context: ApiContext, applicationId: string): Promise<Response> {
  return json({ applicationId, noticeText: await offerTemplate(context.env.DB, applicationId) });
}

async function saveOffer(context: ApiContext, applicationId: string): Promise<Response> {
  const body = await parseJson<OfferInput>(context.request);
  await applicationById(context.env.DB, applicationId);
  const status = body.status === "draft"
    || body.status === "sent"
    || body.status === "accepted"
    || body.status === "declined"
    ? body.status
    : null;
  if (!status) throw new ApiError(422, "錄取通知狀態不正確。");
  const noticeText = body.noticeText === undefined || body.noticeText === ""
    ? await offerTemplate(context.env.DB, applicationId)
    : requiredString(body.noticeText, "錄取通知", 10_000);
  const existing = await context.env.DB.prepare(
    "SELECT id, sent_at AS sentAt FROM recruitment_offers WHERE application_id = ?",
  ).bind(applicationId).first<{ id: string; sentAt: string | null }>();
  const id = existing?.id ?? uuid();
  const sentAt = status === "sent" || status === "accepted" || status === "declined"
    ? existing?.sentAt ?? new Date().toISOString()
    : null;
  const respondedAt = status === "accepted" || status === "declined"
    ? new Date().toISOString()
    : null;
  await context.env.DB.prepare(`
    INSERT INTO recruitment_offers (
      id, application_id, status, notice_text, sent_at, responded_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(application_id) DO UPDATE SET
      status = excluded.status,
      notice_text = excluded.notice_text,
      sent_at = excluded.sent_at,
      responded_at = excluded.responded_at,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).bind(id, applicationId, status, noticeText, sentAt, respondedAt).run();
  return json({ id, applicationId, status, noticeText, sentAt, respondedAt });
}

async function deleteOffer(context: ApiContext, applicationId: string): Promise<Response> {
  const result = await context.env.DB.prepare(
    "DELETE FROM recruitment_offers WHERE application_id = ?",
  ).bind(applicationId).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定錄取通知。");
  return json({ applicationId, deleted: true });
}

async function listOnboardingItems(context: ApiContext): Promise<Response> {
  const result = await context.env.DB.prepare(`
    SELECT id, name, required, active FROM onboarding_items
    ORDER BY active DESC, required DESC, name
  `).all();
  return json({ items: result.results });
}

function parseOnboardingItem(body: OnboardingItemInput) {
  return {
    name: requiredString(body.name, "文件項目", 200),
    required: booleanValue(body.required, "是否必填", true) ? 1 : 0,
    active: booleanValue(body.active, "是否啟用", true) ? 1 : 0,
  };
}

async function createOnboardingItem(context: ApiContext): Promise<Response> {
  const item = parseOnboardingItem(await parseJson<OnboardingItemInput>(context.request));
  const id = uuid();
  try {
    await context.env.DB.prepare(`
      INSERT INTO onboarding_items (id, name, required, active) VALUES (?, ?, ?, ?)
    `).bind(id, item.name, item.required, item.active).run();
  } catch {
    throw new ApiError(409, "到職文件項目名稱不可重複。");
  }
  return json({ id, ...item }, 201);
}

async function updateOnboardingItem(context: ApiContext, id: string): Promise<Response> {
  const item = parseOnboardingItem(await parseJson<OnboardingItemInput>(context.request));
  try {
    const result = await context.env.DB.prepare(`
      UPDATE onboarding_items SET name = ?, required = ?, active = ? WHERE id = ?
    `).bind(item.name, item.required, item.active, id).run();
    if (result.meta.changes === 0) throw new ApiError(404, "找不到指定到職文件項目。");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(409, "到職文件項目名稱不可重複。");
  }
  return json({ id, ...item });
}

async function archiveOnboardingItem(context: ApiContext, id: string): Promise<Response> {
  const result = await context.env.DB.prepare(
    "UPDATE onboarding_items SET active = 0 WHERE id = ?",
  ).bind(id).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定到職文件項目。");
  return json({ id, archived: true });
}

async function onboardingChecklist(context: ApiContext, applicationId: string): Promise<Response> {
  const application = await applicationById(context.env.DB, applicationId);
  const result = await context.env.DB.prepare(`
    SELECT oi.id AS itemId, oi.name, oi.required, oi.active,
           aoc.id AS checklistId, COALESCE(aoc.completed, 0) AS completed,
           aoc.completed_at AS completedAt, COALESCE(aoc.notes, '') AS notes
    FROM onboarding_items oi
    LEFT JOIN application_onboarding_checklist aoc
      ON aoc.onboarding_item_id = oi.id AND aoc.application_id = ?
    WHERE oi.active = 1 OR aoc.id IS NOT NULL
    ORDER BY oi.active DESC, oi.required DESC, oi.name
  `).bind(applicationId).all();
  return json({ application, items: result.results });
}

async function saveChecklistItem(
  context: ApiContext,
  applicationId: string,
  itemId: string,
): Promise<Response> {
  const body = await parseJson<ChecklistInput>(context.request);
  const completed = booleanValue(body.completed, "完成狀態");
  const notes = optionalString(body.notes, "文件備註", 2000);
  const [application, item] = await Promise.all([
    context.env.DB.prepare("SELECT id FROM candidate_applications WHERE id = ?")
      .bind(applicationId).first(),
    context.env.DB.prepare("SELECT id FROM onboarding_items WHERE id = ?").bind(itemId).first(),
  ]);
  if (!application) throw new ApiError(404, "找不到指定應徵紀錄。");
  if (!item) throw new ApiError(404, "找不到指定到職文件項目。");
  const existing = await context.env.DB.prepare(`
    SELECT id FROM application_onboarding_checklist
    WHERE application_id = ? AND onboarding_item_id = ?
  `).bind(applicationId, itemId).first<{ id: string }>();
  const id = existing?.id ?? uuid();
  await context.env.DB.prepare(`
    INSERT INTO application_onboarding_checklist (
      id, application_id, onboarding_item_id, completed, completed_at, notes
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(application_id, onboarding_item_id) DO UPDATE SET
      completed = excluded.completed,
      completed_at = excluded.completed_at,
      notes = excluded.notes
  `).bind(
    id,
    applicationId,
    itemId,
    completed ? 1 : 0,
    completed ? new Date().toISOString() : null,
    notes,
  ).run();
  return json({ id, applicationId, itemId, completed, notes });
}

async function probationReminderDays(db: D1Database): Promise<number> {
  const row = await db.prepare(`
    SELECT setting_value AS value FROM settings WHERE setting_key = 'probation_reminder_days'
  `).first<{ value: string }>();
  const value = Number(row?.value ?? "14");
  return Number.isInteger(value) && value >= 1 ? value : 14;
}

export async function probationReminders(db: D1Database): Promise<ProbationReminderRow[]> {
  const reminderDays = await probationReminderDays(db);
  const result = await db.prepare(`
    SELECT p.id, p.employee_id AS employeeId, e.employee_no AS employeeNo,
           e.name AS employeeName, e.department,
           p.candidate_application_id AS candidateApplicationId,
           p.start_date AS startDate, p.duration_days AS durationDays,
           p.due_date AS dueDate, p.result, p.notes,
           CAST(julianday(p.due_date) - julianday(date('now')) AS INTEGER) AS daysUntilDue
    FROM probations p
    JOIN employees e ON e.id = p.employee_id
    WHERE e.status = 'active'
      AND p.result IS NULL
      AND date(p.due_date) <= date('now', '+' || ? || ' day')
    ORDER BY date(p.due_date), e.employee_no
  `).bind(reminderDays).all<ProbationReminderRow>();
  return result.results;
}

async function listProbations(context: ApiContext): Promise<Response> {
  const [settings, reminders, result] = await Promise.all([
    probationReminderDays(context.env.DB),
    probationReminders(context.env.DB),
    context.env.DB.prepare(`
      SELECT p.id, p.employee_id AS employeeId, e.employee_no AS employeeNo,
             e.name AS employeeName, e.department,
             p.candidate_application_id AS candidateApplicationId,
             c.name AS candidateName, jo.title AS jobTitle,
             p.start_date AS startDate, p.duration_days AS durationDays,
             p.due_date AS dueDate, p.result, p.notes,
             CAST(julianday(p.due_date) - julianday(date('now')) AS INTEGER) AS daysUntilDue
      FROM probations p
      JOIN employees e ON e.id = p.employee_id
      LEFT JOIN candidate_applications ca ON ca.id = p.candidate_application_id
      LEFT JOIN candidates c ON c.id = ca.candidate_id
      LEFT JOIN job_openings jo ON jo.id = ca.job_opening_id
      ORDER BY CASE WHEN p.result IS NULL THEN 0 ELSE 1 END, date(p.due_date)
    `).all(),
  ]);
  return json({
    reminderDays: settings,
    reminders,
    probations: result.results,
  });
}

function parseProbation(body: ProbationInput) {
  const result = body.result === undefined || body.result === null || body.result === ""
    ? null
    : body.result === "passed" || body.result === "extended" || body.result === "failed"
      ? body.result
      : undefined;
  if (result === undefined) throw new ApiError(422, "試用期結果不正確。");
  const startDate = isoDate(body.startDate, "到職日");
  const durationDays = integer(body.durationDays, "試用期天數", 1, 730);
  return {
    employeeId: requiredString(body.employeeId, "員工", 100),
    candidateApplicationId: nullableId(body.candidateApplicationId, "應徵紀錄"),
    startDate,
    durationDays,
    dueDate: dueDate(startDate, durationDays),
    result,
    notes: optionalString(body.notes, "試用期備註", 5000),
  };
}

async function createProbation(context: ApiContext): Promise<Response> {
  const probation = parseProbation(await parseJson<ProbationInput>(context.request));
  if (probation.candidateApplicationId) {
    await applicationById(context.env.DB, probation.candidateApplicationId);
  }
  const id = uuid();
  try {
    await context.env.DB.prepare(`
      INSERT INTO probations (
        id, employee_id, candidate_application_id, start_date,
        duration_days, due_date, result, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      probation.employeeId,
      probation.candidateApplicationId,
      probation.startDate,
      probation.durationDays,
      probation.dueDate,
      probation.result,
      probation.notes,
    ).run();
  } catch {
    throw new ApiError(409, "員工不存在，或該員工已有試用期紀錄。");
  }
  return json({ id, ...probation }, 201);
}

async function updateProbation(context: ApiContext, id: string): Promise<Response> {
  const probation = parseProbation(await parseJson<ProbationInput>(context.request));
  if (probation.candidateApplicationId) {
    await applicationById(context.env.DB, probation.candidateApplicationId);
  }
  try {
    const result = await context.env.DB.prepare(`
      UPDATE probations
      SET employee_id = ?, candidate_application_id = ?, start_date = ?,
          duration_days = ?, due_date = ?, result = ?, notes = ?
      WHERE id = ?
    `).bind(
      probation.employeeId,
      probation.candidateApplicationId,
      probation.startDate,
      probation.durationDays,
      probation.dueDate,
      probation.result,
      probation.notes,
      id,
    ).run();
    if (result.meta.changes === 0) throw new ApiError(404, "找不到指定試用期紀錄。");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(409, "員工不存在，或該員工已有試用期紀錄。");
  }
  return json({ id, ...probation });
}

async function deleteProbation(context: ApiContext, id: string): Promise<Response> {
  const result = await context.env.DB.prepare("DELETE FROM probations WHERE id = ?").bind(id).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定試用期紀錄。");
  return json({ id, deleted: true });
}

async function updateProbationSettings(context: ApiContext): Promise<Response> {
  const body = await parseJson<ProbationSettingsInput>(context.request);
  const reminderDays = integer(body.reminderDays, "試用期提醒天數", 1, 365);
  await context.env.DB.prepare(`
    UPDATE settings
    SET setting_value = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE setting_key = 'probation_reminder_days'
  `).bind(String(reminderDays)).run();
  return json({ reminderDays });
}

export async function handleAdminM3(
  context: ApiContext,
  path: string,
): Promise<Response | null> {
  const admin = requireAdmin(context.user);
  const base = "/api/admin/recruitment";
  if (!path.startsWith(base)) return null;

  if (path === `${base}/job-openings` && context.request.method === "GET") {
    return listJobOpenings(context);
  }
  if (path === `${base}/job-openings` && context.request.method === "POST") {
    return createJobOpening(context);
  }
  const openingMatch = path.match(/^\/api\/admin\/recruitment\/job-openings\/([^/]+)$/);
  if (openingMatch?.[1] && context.request.method === "PATCH") {
    return updateJobOpening(context, openingMatch[1]);
  }
  if (openingMatch?.[1] && context.request.method === "DELETE") {
    return deleteJobOpening(context, openingMatch[1]);
  }

  if (path === `${base}/candidates` && context.request.method === "GET") {
    return listCandidates(context);
  }
  if (path === `${base}/candidates` && context.request.method === "POST") {
    return createCandidate(context);
  }
  const candidateApplicationMatch = path.match(
    /^\/api\/admin\/recruitment\/candidates\/([^/]+)\/applications$/,
  );
  if (candidateApplicationMatch?.[1] && context.request.method === "POST") {
    return createApplication(context, admin, candidateApplicationMatch[1]);
  }
  const candidateMatch = path.match(/^\/api\/admin\/recruitment\/candidates\/([^/]+)$/);
  if (candidateMatch?.[1] && context.request.method === "GET") {
    return candidateDetail(context, candidateMatch[1]);
  }
  if (candidateMatch?.[1] && context.request.method === "PATCH") {
    return updateCandidate(context, candidateMatch[1]);
  }
  if (candidateMatch?.[1] && context.request.method === "DELETE") {
    return deleteCandidate(context, candidateMatch[1]);
  }

  if (path === `${base}/applications` && context.request.method === "GET") {
    return listApplications(context);
  }
  const historyMatch = path.match(
    /^\/api\/admin\/recruitment\/applications\/([^/]+)\/history$/,
  );
  if (historyMatch?.[1] && context.request.method === "GET") {
    return applicationHistory(context, historyMatch[1]);
  }
  const transitionMatch = path.match(
    /^\/api\/admin\/recruitment\/applications\/([^/]+)\/transition$/,
  );
  if (transitionMatch?.[1] && context.request.method === "POST") {
    return transitionApplication(context, admin, transitionMatch[1]);
  }
  const checklistMatch = path.match(
    /^\/api\/admin\/recruitment\/applications\/([^/]+)\/onboarding-checklist$/,
  );
  if (checklistMatch?.[1] && context.request.method === "GET") {
    return onboardingChecklist(context, checklistMatch[1]);
  }
  const checklistItemMatch = path.match(
    /^\/api\/admin\/recruitment\/applications\/([^/]+)\/onboarding-checklist\/([^/]+)$/,
  );
  if (checklistItemMatch?.[1] && checklistItemMatch[2] && context.request.method === "PUT") {
    return saveChecklistItem(context, checklistItemMatch[1], checklistItemMatch[2]);
  }
  const applicationMatch = path.match(/^\/api\/admin\/recruitment\/applications\/([^/]+)$/);
  if (applicationMatch?.[1] && context.request.method === "DELETE") {
    return deleteApplication(context, applicationMatch[1]);
  }
  if (path === `${base}/funnel` && context.request.method === "GET") {
    return funnelStats(context);
  }

  if (path === `${base}/interviews` && context.request.method === "GET") {
    return listInterviews(context);
  }
  if (path === `${base}/interviews` && context.request.method === "POST") {
    return createInterview(context);
  }
  const interviewScoresMatch = path.match(
    /^\/api\/admin\/recruitment\/interviews\/([^/]+)\/scores$/,
  );
  if (interviewScoresMatch?.[1] && context.request.method === "PUT") {
    return saveInterviewScores(context, interviewScoresMatch[1]);
  }
  const interviewMatch = path.match(/^\/api\/admin\/recruitment\/interviews\/([^/]+)$/);
  if (interviewMatch?.[1] && context.request.method === "PATCH") {
    return updateInterview(context, interviewMatch[1]);
  }
  if (interviewMatch?.[1] && context.request.method === "DELETE") {
    return deleteInterview(context, interviewMatch[1]);
  }

  if (path === `${base}/salary-approvals` && context.request.method === "GET") {
    return listSalaryApprovals(context);
  }
  const salaryMatch = path.match(
    /^\/api\/admin\/recruitment\/salary-approvals\/([^/]+)$/,
  );
  if (salaryMatch?.[1] && context.request.method === "PUT") {
    return saveSalaryApproval(context, admin, salaryMatch[1]);
  }
  if (salaryMatch?.[1] && context.request.method === "DELETE") {
    return deleteSalaryApproval(context, salaryMatch[1]);
  }

  if (path === `${base}/offers` && context.request.method === "GET") {
    return listOffers(context);
  }
  const templateMatch = path.match(
    /^\/api\/admin\/recruitment\/offers\/([^/]+)\/template$/,
  );
  if (templateMatch?.[1] && context.request.method === "GET") {
    return getOfferTemplate(context, templateMatch[1]);
  }
  const offerMatch = path.match(/^\/api\/admin\/recruitment\/offers\/([^/]+)$/);
  if (offerMatch?.[1] && context.request.method === "PUT") {
    return saveOffer(context, offerMatch[1]);
  }
  if (offerMatch?.[1] && context.request.method === "DELETE") {
    return deleteOffer(context, offerMatch[1]);
  }

  if (path === `${base}/onboarding-items` && context.request.method === "GET") {
    return listOnboardingItems(context);
  }
  if (path === `${base}/onboarding-items` && context.request.method === "POST") {
    return createOnboardingItem(context);
  }
  const itemMatch = path.match(/^\/api\/admin\/recruitment\/onboarding-items\/([^/]+)$/);
  if (itemMatch?.[1] && context.request.method === "PATCH") {
    return updateOnboardingItem(context, itemMatch[1]);
  }
  if (itemMatch?.[1] && context.request.method === "DELETE") {
    return archiveOnboardingItem(context, itemMatch[1]);
  }

  if (path === `${base}/probations` && context.request.method === "GET") {
    return listProbations(context);
  }
  if (path === `${base}/probations` && context.request.method === "POST") {
    return createProbation(context);
  }
  if (path === `${base}/probation-settings` && context.request.method === "PATCH") {
    return updateProbationSettings(context);
  }
  const probationMatch = path.match(/^\/api\/admin\/recruitment\/probations\/([^/]+)$/);
  if (probationMatch?.[1] && context.request.method === "PATCH") {
    return updateProbation(context, probationMatch[1]);
  }
  if (probationMatch?.[1] && context.request.method === "DELETE") {
    return deleteProbation(context, probationMatch[1]);
  }

  return null;
}
