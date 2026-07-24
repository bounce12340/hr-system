import {
  ApiError,
  json,
  optionalString,
  parseJson,
  requiredString,
  requireEmployeeIdentity,
  uuid,
} from "./http";
import type { ApiContext, AuthUser } from "./types";
import { probationReminders } from "./m3";

interface SettingRow {
  settingKey: string;
  settingValue: string;
}

interface TrainingSettings {
  certificationReminderDays: number;
  electiveEnrollmentRequiresApproval: boolean;
}

interface TrainingSettingsInput {
  certificationReminderDays?: unknown;
  electiveEnrollmentRequiresApproval?: unknown;
}

interface EnrollmentDecisionInput {
  action?: unknown;
  note?: unknown;
}

interface TestInput {
  courseSessionId?: unknown;
  name?: unknown;
  passingScore?: unknown;
}

interface TestResultsInput {
  records?: unknown;
}

interface TestResultInput {
  employeeId?: unknown;
  score?: unknown;
}

interface CertificationTypeInput {
  name?: unknown;
  issuer?: unknown;
  defaultValidityMonths?: unknown;
  active?: unknown;
}

interface EmployeeCertificationInput {
  employeeId?: unknown;
  certificationId?: unknown;
  certificateNumber?: unknown;
  issuedAt?: unknown;
  expiresAt?: unknown;
  notes?: unknown;
}

interface MandatoryTrainingRow {
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  department: string;
  grade: string;
  jobType: string;
  requiredLevel: number;
  courseId: string;
  courseName: string;
  competencyLevel: number;
  completed: number;
  completedAt: string | null;
  validUntil: string | null;
}

interface ExpiryReminderRow {
  id: string;
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  department: string;
  certificationId: string;
  certificationName: string;
  issuer: string;
  certificateNumber: string | null;
  issuedAt: string;
  expiresAt: string;
  notes: string;
  daysUntilExpiry: number;
}

interface TestRow {
  id: string;
  courseSessionId: string;
  name: string;
  passingScore: number;
  courseName: string;
  sessionDate: string;
  startTime: string;
  endTime: string;
}

interface TestCandidateRow {
  testId: string;
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  department: string;
  score: number | null;
  passed: number | null;
  retrainingRequired: number | null;
  recordedAt: string | null;
}

interface MatrixRow {
  jobTypeId: string;
  courseId: string;
  employeeCount: number;
  completedCount: number;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ApiError(422, `${label}須為 ${min}～${max} 的整數。`);
  }
  return value;
}

function score(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new ApiError(422, `${label}須為 0～100 的數字。`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new ApiError(422, `${label}格式不正確。`);
  return value;
}

function isoDate(value: unknown, label: string, nullable = false): string | null {
  if (nullable && (value === undefined || value === null || value === "")) return null;
  const text = requiredString(value, label, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new ApiError(422, `${label}格式須為 YYYY-MM-DD。`);
  }
  return text;
}

function nullablePositiveInteger(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  return integer(value, label, 1, 1200);
}

async function getTrainingSettings(db: D1Database): Promise<TrainingSettings> {
  const result = await db.prepare(`
    SELECT setting_key AS settingKey, setting_value AS settingValue
    FROM settings
    WHERE setting_key IN ('certification_reminder_days', 'elective_enrollment_requires_approval')
  `).all<SettingRow>();
  const values = new Map(result.results.map((item) => [item.settingKey, item.settingValue]));
  const reminderDays = Number(values.get("certification_reminder_days") ?? "60");
  return {
    certificationReminderDays: Number.isInteger(reminderDays) && reminderDays >= 1 ? reminderDays : 60,
    electiveEnrollmentRequiresApproval:
      (values.get("elective_enrollment_requires_approval") ?? "false") === "true",
  };
}

export async function enrollmentRequiresApproval(db: D1Database): Promise<boolean> {
  return (await getTrainingSettings(db)).electiveEnrollmentRequiresApproval;
}

async function updateTrainingSettings(context: ApiContext): Promise<Response> {
  const body = await parseJson<TrainingSettingsInput>(context.request);
  const reminderDays = integer(body.certificationReminderDays, "證照提醒天數", 1, 3650);
  const requiresApproval = booleanValue(
    body.electiveEnrollmentRequiresApproval,
    "報名審核設定",
  );
  await context.env.DB.batch([
    context.env.DB.prepare(`
      UPDATE settings SET setting_value = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE setting_key = 'certification_reminder_days'
    `).bind(String(reminderDays)),
    context.env.DB.prepare(`
      UPDATE settings SET setting_value = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE setting_key = 'elective_enrollment_requires_approval'
    `).bind(String(requiresApproval)),
  ]);
  return json({ settings: await getTrainingSettings(context.env.DB) });
}

async function expiryReminders(db: D1Database, employeeId?: string): Promise<ExpiryReminderRow[]> {
  const settings = await getTrainingSettings(db);
  const employeeFilter = employeeId ? "AND ec.employee_id = ?" : "";
  const statement = db.prepare(`
    SELECT ec.id, ec.employee_id AS employeeId, e.employee_no AS employeeNo,
           e.name AS employeeName, e.department,
           cert.id AS certificationId, cert.name AS certificationName, cert.issuer,
           ec.certificate_number AS certificateNumber, ec.issued_at AS issuedAt,
           ec.expires_at AS expiresAt, ec.notes,
           CAST(julianday(ec.expires_at) - julianday(date('now')) AS INTEGER) AS daysUntilExpiry
    FROM employee_certifications ec
    JOIN employees e ON e.id = ec.employee_id
    JOIN certifications cert ON cert.id = ec.certification_id
    WHERE e.status = 'active' AND ec.expires_at IS NOT NULL
      AND date(ec.expires_at) <= date('now', '+' || ? || ' day')
      ${employeeFilter}
    ORDER BY date(ec.expires_at), e.employee_no
  `);
  const result = employeeId
    ? await statement.bind(settings.certificationReminderDays, employeeId).all<ExpiryReminderRow>()
    : await statement.bind(settings.certificationReminderDays).all<ExpiryReminderRow>();
  return result.results;
}

async function dashboard(context: ApiContext): Promise<Response> {
  const [settings, reminders, probationReminderRows, pending, retraining, mandatory] = await Promise.all([
    getTrainingSettings(context.env.DB),
    expiryReminders(context.env.DB),
    probationReminders(context.env.DB),
    context.env.DB.prepare(`
      SELECT COUNT(*) AS count FROM enrollments
      WHERE source = 'self' AND enrollment_status = 'waitlisted'
    `).first<{ count: number }>(),
    context.env.DB.prepare(`
      SELECT COUNT(*) AS count FROM test_results WHERE retraining_required = 1
    `).first<{ count: number }>(),
    mandatoryTraining(context.env.DB),
  ]);
  const missingMandatoryCount = mandatory.reduce(
    (sum, employee) => sum + employee.courses.filter((course) => !course.completed).length,
    0,
  );
  return json({
    settings,
    certificationReminders: reminders,
    probationReminders: probationReminderRows,
    pendingEnrollmentCount: pending?.count ?? 0,
    retrainingRequiredCount: retraining?.count ?? 0,
    missingMandatoryCount,
  });
}

async function mandatoryTraining(
  db: D1Database,
  department?: string,
  employeeId?: string,
): Promise<Array<{
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  department: string;
  grade: string;
  jobType: string;
  requiredLevel: number;
  requiredCount: number;
  completedCount: number;
  completionRate: number;
  courses: Array<{
    courseId: string;
    courseName: string;
    competencyLevel: number;
    completed: boolean;
    completedAt: string | null;
    validUntil: string | null;
  }>;
}>> {
  const filters = ["e.status = 'active'", "c.active = 1", "c.course_type = 'mandatory'"];
  const bindings: string[] = [];
  if (department) {
    filters.push("e.department = ?");
    bindings.push(department);
  }
  if (employeeId) {
    filters.push("e.id = ?");
    bindings.push(employeeId);
  }
  const result = await db.prepare(`
    SELECT e.id AS employeeId, e.employee_no AS employeeNo, e.name AS employeeName,
           e.department, e.grade, jt.name AS jobType, jt.required_level AS requiredLevel,
           c.id AS courseId, c.name AS courseName, c.competency_level AS competencyLevel,
           CASE WHEN MAX(tr.completed_at) IS NULL THEN 0 ELSE 1 END AS completed,
           MAX(tr.completed_at) AS completedAt, MAX(tr.valid_until) AS validUntil
    FROM employees e
    JOIN job_types jt ON jt.id = e.job_type_id
    JOIN courses c ON c.competency_level <= jt.required_level
    LEFT JOIN training_records tr ON tr.employee_id = e.id AND tr.course_id = c.id
    WHERE ${filters.join(" AND ")}
    GROUP BY e.id, c.id
    ORDER BY e.department, e.employee_no, c.competency_level, c.name
  `).bind(...bindings).all<MandatoryTrainingRow>();
  const employees = new Map<string, {
    employeeId: string;
    employeeNo: string;
    employeeName: string;
    department: string;
    grade: string;
    jobType: string;
    requiredLevel: number;
    courses: Array<{
      courseId: string;
      courseName: string;
      competencyLevel: number;
      completed: boolean;
      completedAt: string | null;
      validUntil: string | null;
    }>;
  }>();
  for (const row of result.results) {
    const existing = employees.get(row.employeeId) ?? {
      employeeId: row.employeeId,
      employeeNo: row.employeeNo,
      employeeName: row.employeeName,
      department: row.department,
      grade: row.grade,
      jobType: row.jobType,
      requiredLevel: row.requiredLevel,
      courses: [],
    };
    existing.courses.push({
      courseId: row.courseId,
      courseName: row.courseName,
      competencyLevel: row.competencyLevel,
      completed: row.completed === 1,
      completedAt: row.completedAt,
      validUntil: row.validUntil,
    });
    employees.set(row.employeeId, existing);
  }
  return [...employees.values()].map((employee) => {
    const completedCount = employee.courses.filter((course) => course.completed).length;
    return {
      ...employee,
      requiredCount: employee.courses.length,
      completedCount,
      completionRate: employee.courses.length
        ? Math.round((completedCount / employee.courses.length) * 100)
        : 100,
    };
  });
}

async function listMandatoryTraining(context: ApiContext): Promise<Response> {
  const department = context.url.searchParams.get("department") || undefined;
  const employees = await mandatoryTraining(context.env.DB, department);
  const departments = await context.env.DB.prepare(`
    SELECT DISTINCT department FROM employees WHERE status = 'active' ORDER BY department
  `).all<{ department: string }>();
  return json({ employees, departments: departments.results.map((row) => row.department) });
}

async function listEnrollmentRequests(context: ApiContext): Promise<Response> {
  const result = await context.env.DB.prepare(`
    SELECT en.id, en.enrollment_status AS status, en.assigned_at AS requestedAt,
           en.reviewed_at AS reviewedAt, en.review_note AS reviewNote,
           e.id AS employeeId, e.employee_no AS employeeNo, e.name AS employeeName,
           e.department, c.name AS courseName, cs.id AS courseSessionId,
           cs.session_date AS sessionDate, cs.start_time AS startTime,
           cs.end_time AS endTime, cs.location
    FROM enrollments en
    JOIN employees e ON e.id = en.employee_id
    JOIN course_sessions cs ON cs.id = en.course_session_id
    JOIN courses c ON c.id = cs.course_id
    WHERE en.source = 'self'
    ORDER BY CASE en.enrollment_status WHEN 'waitlisted' THEN 0 ELSE 1 END,
             en.assigned_at DESC
  `).all();
  return json({ requests: result.results, settings: await getTrainingSettings(context.env.DB) });
}

async function decideEnrollment(
  context: ApiContext,
  admin: AuthUser,
  id: string,
): Promise<Response> {
  const body = await parseJson<EnrollmentDecisionInput>(context.request);
  const action = body.action === "approve" || body.action === "reject" ? body.action : null;
  if (!action) throw new ApiError(422, "審核動作必須是核准或駁回。");
  const note = optionalString(body.note, "審核備註", 1000);
  const request = await context.env.DB.prepare(`
    SELECT en.id, en.employee_id AS employeeId, en.course_session_id AS courseSessionId,
           en.enrollment_status AS status, cs.session_date AS sessionDate,
           cs.start_time AS startTime, cs.end_time AS endTime, cs.capacity
    FROM enrollments en
    JOIN course_sessions cs ON cs.id = en.course_session_id
    WHERE en.id = ? AND en.source = 'self'
  `).bind(id).first<{
    id: string;
    employeeId: string;
    courseSessionId: string;
    status: string;
    sessionDate: string;
    startTime: string;
    endTime: string;
    capacity: number;
  }>();
  if (!request) throw new ApiError(404, "找不到指定報名申請。");
  if (request.status !== "waitlisted") throw new ApiError(409, "此報名申請已完成審核。");

  if (action === "approve") {
    const conflict = await context.env.DB.prepare(`
      SELECT c.name AS courseName
      FROM enrollments en
      JOIN course_sessions cs ON cs.id = en.course_session_id
      JOIN courses c ON c.id = cs.course_id
      WHERE en.employee_id = ? AND en.enrollment_status = 'enrolled'
        AND cs.status <> 'cancelled' AND cs.session_date = ?
        AND cs.start_time < ? AND cs.end_time > ?
        AND cs.id <> ?
      LIMIT 1
    `).bind(
      request.employeeId,
      request.sessionDate,
      request.endTime,
      request.startTime,
      request.courseSessionId,
    ).first<{ courseName: string }>();
    if (conflict) throw new ApiError(409, `與既有課程「${conflict.courseName}」時段衝突，無法核准。`);
    const count = await context.env.DB.prepare(`
      SELECT COUNT(*) AS count FROM enrollments
      WHERE course_session_id = ? AND enrollment_status = 'enrolled'
    `).bind(request.courseSessionId).first<{ count: number }>();
    if ((count?.count ?? 0) >= request.capacity) throw new ApiError(409, "此場次名額已滿，無法核准。");
  }

  const status = action === "approve" ? "enrolled" : "cancelled";
  await context.env.DB.batch([
    context.env.DB.prepare(`
      UPDATE enrollments
      SET enrollment_status = ?, reviewed_by = ?,
          reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), review_note = ?
      WHERE id = ? AND enrollment_status = 'waitlisted'
    `).bind(status, admin.id, note, id),
    context.env.DB.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, details)
      VALUES (?, ?, ?, 'enrollment', ?, ?)
    `).bind(uuid(), admin.id, `enrollment_${action}`, id, JSON.stringify({ note })),
  ]);
  return json({ id, status });
}

async function listTests(context: ApiContext): Promise<Response> {
  const sessionId = context.url.searchParams.get("sessionId");
  const condition = sessionId ? "WHERE t.course_session_id = ?" : "";
  const testsStatement = context.env.DB.prepare(`
    SELECT t.id, t.course_session_id AS courseSessionId, t.name,
           t.passing_score AS passingScore, c.name AS courseName,
           cs.session_date AS sessionDate, cs.start_time AS startTime, cs.end_time AS endTime
    FROM tests t
    JOIN course_sessions cs ON cs.id = t.course_session_id
    JOIN courses c ON c.id = cs.course_id
    ${condition}
    ORDER BY cs.session_date DESC, t.created_at DESC
  `);
  const testsResult = sessionId
    ? await testsStatement.bind(sessionId).all<TestRow>()
    : await testsStatement.all<TestRow>();
  if (testsResult.results.length === 0) return json({ tests: [] });
  const placeholders = testsResult.results.map(() => "?").join(", ");
  const candidates = await context.env.DB.prepare(`
    SELECT t.id AS testId, e.id AS employeeId, e.employee_no AS employeeNo,
           e.name AS employeeName, e.department, tr.score, tr.passed,
           tr.retraining_required AS retrainingRequired, tr.recorded_at AS recordedAt
    FROM tests t
    JOIN enrollments en ON en.course_session_id = t.course_session_id
      AND en.enrollment_status = 'enrolled'
    JOIN employees e ON e.id = en.employee_id
    LEFT JOIN test_results tr ON tr.test_id = t.id AND tr.employee_id = e.id
    WHERE t.id IN (${placeholders})
    ORDER BY e.employee_no
  `).bind(...testsResult.results.map((test) => test.id)).all<TestCandidateRow>();
  return json({
    tests: testsResult.results.map((test) => ({
      ...test,
      results: candidates.results.filter((candidate) => candidate.testId === test.id),
    })),
  });
}

function parseTest(body: TestInput): { courseSessionId: string; name: string; passingScore: number } {
  return {
    courseSessionId: requiredString(body.courseSessionId, "場次", 100),
    name: requiredString(body.name, "測驗名稱", 200),
    passingScore: score(body.passingScore, "通過門檻"),
  };
}

async function createTest(context: ApiContext): Promise<Response> {
  const test = parseTest(await parseJson<TestInput>(context.request));
  const session = await context.env.DB.prepare(
    "SELECT id FROM course_sessions WHERE id = ?",
  ).bind(test.courseSessionId).first();
  if (!session) throw new ApiError(404, "找不到指定場次。");
  const id = uuid();
  await context.env.DB.prepare(`
    INSERT INTO tests (id, course_session_id, name, passing_score) VALUES (?, ?, ?, ?)
  `).bind(id, test.courseSessionId, test.name, test.passingScore).run();
  return json({ id, ...test }, 201);
}

async function updateTest(context: ApiContext, id: string): Promise<Response> {
  const test = parseTest(await parseJson<TestInput>(context.request));
  const result = await context.env.DB.prepare(`
    UPDATE tests SET course_session_id = ?, name = ?, passing_score = ? WHERE id = ?
  `).bind(test.courseSessionId, test.name, test.passingScore, id).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定測驗。");
  await context.env.DB.prepare(`
    UPDATE test_results
    SET passed = CASE WHEN score >= ? THEN 1 ELSE 0 END,
        retraining_required = CASE WHEN score >= ? THEN 0 ELSE 1 END
    WHERE test_id = ?
  `).bind(test.passingScore, test.passingScore, id).run();
  return json({ id, ...test });
}

async function deleteTest(context: ApiContext, id: string): Promise<Response> {
  const result = await context.env.DB.prepare("DELETE FROM tests WHERE id = ?").bind(id).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定測驗。");
  return json({ id, deleted: true });
}

async function recordTestResults(context: ApiContext, id: string): Promise<Response> {
  const body = await parseJson<TestResultsInput>(context.request);
  if (!Array.isArray(body.records) || body.records.length === 0) {
    throw new ApiError(422, "請至少提供一筆測驗成績。");
  }
  const records = body.records.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ApiError(422, "測驗成績格式不正確。");
    }
    const item = value as TestResultInput;
    return {
      employeeId: requiredString(item.employeeId, "員工", 100),
      score: score(item.score, "分數"),
    };
  });
  if (new Set(records.map((record) => record.employeeId)).size !== records.length) {
    throw new ApiError(422, "同一員工不可重複登錄成績。");
  }
  const test = await context.env.DB.prepare(`
    SELECT id, course_session_id AS courseSessionId, passing_score AS passingScore
    FROM tests WHERE id = ?
  `).bind(id).first<{ id: string; courseSessionId: string; passingScore: number }>();
  if (!test) throw new ApiError(404, "找不到指定測驗。");
  const placeholders = records.map(() => "?").join(", ");
  const enrolled = await context.env.DB.prepare(`
    SELECT employee_id AS employeeId FROM enrollments
    WHERE course_session_id = ? AND enrollment_status = 'enrolled'
      AND employee_id IN (${placeholders})
  `).bind(test.courseSessionId, ...records.map((record) => record.employeeId))
    .all<{ employeeId: string }>();
  const enrolledIds = new Set(enrolled.results.map((item) => item.employeeId));
  if (records.some((record) => !enrolledIds.has(record.employeeId))) {
    throw new ApiError(422, "成績名單包含未參加此場次的員工。");
  }
  await context.env.DB.batch(records.map((record) => {
    const passed = record.score >= test.passingScore ? 1 : 0;
    return context.env.DB.prepare(`
      INSERT INTO test_results (
        id, test_id, employee_id, score, passed, retraining_required, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(test_id, employee_id) DO UPDATE SET
        score = excluded.score, passed = excluded.passed,
        retraining_required = excluded.retraining_required, recorded_at = excluded.recorded_at
    `).bind(uuid(), id, record.employeeId, record.score, passed, passed ? 0 : 1);
  }));
  return json({ recordedCount: records.length });
}

async function listCertificationTypes(context: ApiContext): Promise<Response> {
  const result = await context.env.DB.prepare(`
    SELECT id, name, issuer, default_validity_months AS defaultValidityMonths, active
    FROM certifications ORDER BY active DESC, name
  `).all();
  return json({ certificationTypes: result.results });
}

function parseCertificationType(body: CertificationTypeInput): {
  name: string;
  issuer: string;
  defaultValidityMonths: number | null;
  active: number;
} {
  return {
    name: requiredString(body.name, "證照名稱", 200),
    issuer: requiredString(body.issuer, "發證單位", 200),
    defaultValidityMonths: nullablePositiveInteger(body.defaultValidityMonths, "預設效期"),
    active: body.active === undefined ? 1 : booleanValue(body.active, "啟用狀態") ? 1 : 0,
  };
}

async function createCertificationType(context: ApiContext): Promise<Response> {
  const certification = parseCertificationType(await parseJson<CertificationTypeInput>(context.request));
  const id = uuid();
  try {
    await context.env.DB.prepare(`
      INSERT INTO certifications (id, name, issuer, default_validity_months, active)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      id,
      certification.name,
      certification.issuer,
      certification.defaultValidityMonths,
      certification.active,
    ).run();
  } catch {
    throw new ApiError(409, "已有同名證照類型。");
  }
  return json({ certificationType: { id, ...certification } }, 201);
}

async function updateCertificationType(context: ApiContext, id: string): Promise<Response> {
  const certification = parseCertificationType(await parseJson<CertificationTypeInput>(context.request));
  try {
    const result = await context.env.DB.prepare(`
      UPDATE certifications SET name = ?, issuer = ?, default_validity_months = ?, active = ?
      WHERE id = ?
    `).bind(
      certification.name,
      certification.issuer,
      certification.defaultValidityMonths,
      certification.active,
      id,
    ).run();
    if (result.meta.changes === 0) throw new ApiError(404, "找不到指定證照類型。");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(409, "已有同名證照類型。");
  }
  return json({ certificationType: { id, ...certification } });
}

async function archiveCertificationType(context: ApiContext, id: string): Promise<Response> {
  const result = await context.env.DB.prepare(
    "UPDATE certifications SET active = 0 WHERE id = ?",
  ).bind(id).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定證照類型。");
  return json({ id, archived: true });
}

async function listEmployeeCertifications(context: ApiContext): Promise<Response> {
  const employeeId = context.url.searchParams.get("employeeId");
  const condition = employeeId ? "WHERE ec.employee_id = ?" : "";
  const statement = context.env.DB.prepare(`
    SELECT ec.id, ec.employee_id AS employeeId, e.employee_no AS employeeNo,
           e.name AS employeeName, e.department,
           cert.id AS certificationId, cert.name AS certificationName, cert.issuer,
           ec.certificate_number AS certificateNumber, ec.issued_at AS issuedAt,
           ec.expires_at AS expiresAt, ec.notes,
           CASE WHEN ec.expires_at IS NULL THEN NULL
             ELSE CAST(julianday(ec.expires_at) - julianday(date('now')) AS INTEGER)
           END AS daysUntilExpiry
    FROM employee_certifications ec
    JOIN employees e ON e.id = ec.employee_id
    JOIN certifications cert ON cert.id = ec.certification_id
    ${condition}
    ORDER BY CASE WHEN ec.expires_at IS NULL THEN 1 ELSE 0 END, ec.expires_at, e.employee_no
  `);
  const result = employeeId ? await statement.bind(employeeId).all() : await statement.all();
  return json({ certifications: result.results, settings: await getTrainingSettings(context.env.DB) });
}

function parseEmployeeCertification(body: EmployeeCertificationInput): {
  employeeId: string;
  certificationId: string;
  certificateNumber: string;
  issuedAt: string;
  expiresAt: string | null;
  notes: string;
} {
  const issuedAt = isoDate(body.issuedAt, "取得日");
  const expiresAt = isoDate(body.expiresAt, "到期日", true);
  if (expiresAt && issuedAt && expiresAt < issuedAt) {
    throw new ApiError(422, "到期日不可早於取得日。");
  }
  return {
    employeeId: requiredString(body.employeeId, "員工", 100),
    certificationId: requiredString(body.certificationId, "證照類型", 100),
    certificateNumber: optionalString(body.certificateNumber, "證號", 200),
    issuedAt: issuedAt ?? "",
    expiresAt,
    notes: optionalString(body.notes, "備註", 2000),
  };
}

async function createEmployeeCertification(context: ApiContext): Promise<Response> {
  const certification = parseEmployeeCertification(
    await parseJson<EmployeeCertificationInput>(context.request),
  );
  const id = uuid();
  try {
    await context.env.DB.prepare(`
      INSERT INTO employee_certifications (
        id, employee_id, certification_id, certificate_number, issued_at, expires_at, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      certification.employeeId,
      certification.certificationId,
      certification.certificateNumber || null,
      certification.issuedAt,
      certification.expiresAt,
      certification.notes,
    ).run();
  } catch {
    throw new ApiError(422, "員工或證照類型不存在。");
  }
  return json({ id, ...certification }, 201);
}

async function updateEmployeeCertification(
  context: ApiContext,
  id: string,
): Promise<Response> {
  const certification = parseEmployeeCertification(
    await parseJson<EmployeeCertificationInput>(context.request),
  );
  try {
    const result = await context.env.DB.prepare(`
      UPDATE employee_certifications
      SET employee_id = ?, certification_id = ?, certificate_number = ?,
          issued_at = ?, expires_at = ?, notes = ?
      WHERE id = ?
    `).bind(
      certification.employeeId,
      certification.certificationId,
      certification.certificateNumber || null,
      certification.issuedAt,
      certification.expiresAt,
      certification.notes,
      id,
    ).run();
    if (result.meta.changes === 0) throw new ApiError(404, "找不到指定員工證照。");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "員工或證照類型不存在。");
  }
  return json({ id, ...certification });
}

async function deleteEmployeeCertification(context: ApiContext, id: string): Promise<Response> {
  const result = await context.env.DB.prepare(
    "DELETE FROM employee_certifications WHERE id = ?",
  ).bind(id).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定員工證照。");
  return json({ id, deleted: true });
}

async function trainingMatrix(context: ApiContext): Promise<Response> {
  const [jobTypes, courses, matrix] = await Promise.all([
    context.env.DB.prepare(`
      SELECT id, name, required_level AS requiredLevel,
             (SELECT COUNT(*) FROM employees e
              WHERE e.job_type_id = jt.id AND e.status = 'active') AS employeeCount
      FROM job_types jt WHERE active = 1 ORDER BY required_level, name
    `).all<{ id: string; name: string; requiredLevel: number; employeeCount: number }>(),
    context.env.DB.prepare(`
      SELECT id, name, competency_level AS competencyLevel
      FROM courses
      WHERE active = 1 AND course_type = 'mandatory'
      ORDER BY competency_level, name
    `).all<{ id: string; name: string; competencyLevel: number }>(),
    context.env.DB.prepare(`
      SELECT jt.id AS jobTypeId, c.id AS courseId,
             COUNT(DISTINCT e.id) AS employeeCount,
             COUNT(DISTINCT CASE WHEN tr.id IS NOT NULL THEN e.id END) AS completedCount
      FROM job_types jt
      JOIN employees e ON e.job_type_id = jt.id AND e.status = 'active'
      JOIN courses c ON c.active = 1 AND c.course_type = 'mandatory'
        AND c.competency_level <= jt.required_level
      LEFT JOIN training_records tr ON tr.employee_id = e.id AND tr.course_id = c.id
      WHERE jt.active = 1
      GROUP BY jt.id, c.id
    `).all<MatrixRow>(),
  ]);
  const cells = jobTypes.results.flatMap((jobType) => courses.results.map((course) => {
    const required = course.competencyLevel <= jobType.requiredLevel;
    const value = matrix.results.find(
      (item) => item.jobTypeId === jobType.id && item.courseId === course.id,
    );
    const completedCount = value?.completedCount ?? 0;
    const employeeCount = required ? (value?.employeeCount ?? jobType.employeeCount) : 0;
    const completionRate = required && employeeCount > 0
      ? Math.round((completedCount / employeeCount) * 100)
      : required ? 100 : null;
    const status = completionRate === null
      ? "not_required"
      : completionRate >= 80
        ? "green"
        : completionRate >= 50
          ? "yellow"
          : "red";
    return {
      jobTypeId: jobType.id,
      courseId: course.id,
      required,
      employeeCount,
      completedCount,
      completionRate,
      status,
    };
  }));
  return json({
    jobTypes: jobTypes.results,
    courses: courses.results,
    cells,
    thresholds: { green: 80, yellow: 50 },
  });
}

async function employeeHome(
  context: ApiContext,
  user: AuthUser & { employeeId: string },
): Promise<Response> {
  const [settings, reminders, mandatory, upcoming] = await Promise.all([
    getTrainingSettings(context.env.DB),
    expiryReminders(context.env.DB, user.employeeId),
    mandatoryTraining(context.env.DB, undefined, user.employeeId),
    context.env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM enrollments en
      JOIN course_sessions cs ON cs.id = en.course_session_id
      WHERE en.employee_id = ? AND en.enrollment_status = 'enrolled'
        AND cs.status = 'scheduled' AND cs.session_date >= date('now')
    `).bind(user.employeeId).first<{ count: number }>(),
  ]);
  return json({
    settings,
    certificationReminders: reminders,
    mandatoryTraining: mandatory[0] ?? null,
    upcomingSessionCount: upcoming?.count ?? 0,
  });
}

async function employeeCertifications(
  context: ApiContext,
  user: AuthUser & { employeeId: string },
): Promise<Response> {
  const result = await context.env.DB.prepare(`
    SELECT ec.id, cert.name AS certificationName, cert.issuer,
           ec.certificate_number AS certificateNumber, ec.issued_at AS issuedAt,
           ec.expires_at AS expiresAt, ec.notes,
           CASE WHEN ec.expires_at IS NULL THEN NULL
             ELSE CAST(julianday(ec.expires_at) - julianday(date('now')) AS INTEGER)
           END AS daysUntilExpiry
    FROM employee_certifications ec
    JOIN certifications cert ON cert.id = ec.certification_id
    WHERE ec.employee_id = ?
    ORDER BY CASE WHEN ec.expires_at IS NULL THEN 1 ELSE 0 END, ec.expires_at
  `).bind(user.employeeId).all();
  return json({ certifications: result.results, settings: await getTrainingSettings(context.env.DB) });
}

export async function handleAdminM2(context: ApiContext, path: string): Promise<Response | null> {
  const admin = context.user;
  if (!admin) throw new ApiError(401, "請先登入。");

  if (path === "/api/admin/dashboard" && context.request.method === "GET") return dashboard(context);
  if (path === "/api/admin/training-settings" && context.request.method === "GET") {
    return json({ settings: await getTrainingSettings(context.env.DB) });
  }
  if (path === "/api/admin/training-settings" && context.request.method === "PATCH") {
    return updateTrainingSettings(context);
  }
  if (path === "/api/admin/mandatory-training" && context.request.method === "GET") {
    return listMandatoryTraining(context);
  }
  if (path === "/api/admin/enrollment-requests" && context.request.method === "GET") {
    return listEnrollmentRequests(context);
  }
  const requestMatch = path.match(/^\/api\/admin\/enrollment-requests\/([^/]+)$/);
  if (requestMatch?.[1] && context.request.method === "PATCH") {
    return decideEnrollment(context, admin, requestMatch[1]);
  }

  if (path === "/api/admin/tests" && context.request.method === "GET") return listTests(context);
  if (path === "/api/admin/tests" && context.request.method === "POST") return createTest(context);
  const testResultsMatch = path.match(/^\/api\/admin\/tests\/([^/]+)\/results$/);
  if (testResultsMatch?.[1] && context.request.method === "PUT") {
    return recordTestResults(context, testResultsMatch[1]);
  }
  const testMatch = path.match(/^\/api\/admin\/tests\/([^/]+)$/);
  if (testMatch?.[1] && context.request.method === "PATCH") return updateTest(context, testMatch[1]);
  if (testMatch?.[1] && context.request.method === "DELETE") return deleteTest(context, testMatch[1]);

  if (path === "/api/admin/certification-types" && context.request.method === "GET") {
    return listCertificationTypes(context);
  }
  if (path === "/api/admin/certification-types" && context.request.method === "POST") {
    return createCertificationType(context);
  }
  const typeMatch = path.match(/^\/api\/admin\/certification-types\/([^/]+)$/);
  if (typeMatch?.[1] && context.request.method === "PATCH") {
    return updateCertificationType(context, typeMatch[1]);
  }
  if (typeMatch?.[1] && context.request.method === "DELETE") {
    return archiveCertificationType(context, typeMatch[1]);
  }

  if (path === "/api/admin/employee-certifications" && context.request.method === "GET") {
    return listEmployeeCertifications(context);
  }
  if (path === "/api/admin/employee-certifications" && context.request.method === "POST") {
    return createEmployeeCertification(context);
  }
  const certificationMatch = path.match(/^\/api\/admin\/employee-certifications\/([^/]+)$/);
  if (certificationMatch?.[1] && context.request.method === "PATCH") {
    return updateEmployeeCertification(context, certificationMatch[1]);
  }
  if (certificationMatch?.[1] && context.request.method === "DELETE") {
    return deleteEmployeeCertification(context, certificationMatch[1]);
  }
  if (path === "/api/admin/training-matrix" && context.request.method === "GET") {
    return trainingMatrix(context);
  }
  return null;
}

export async function handleEmployeeM2(context: ApiContext, path: string): Promise<Response | null> {
  const user = requireEmployeeIdentity(context.user);
  if (path === "/api/employee/home" && context.request.method === "GET") {
    return employeeHome(context, user);
  }
  if (path === "/api/employee/mandatory-training" && context.request.method === "GET") {
    return json({ training: (await mandatoryTraining(context.env.DB, undefined, user.employeeId))[0] ?? null });
  }
  if (path === "/api/employee/certifications" && context.request.method === "GET") {
    return employeeCertifications(context, user);
  }
  return null;
}
