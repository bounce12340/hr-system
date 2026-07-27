import { deactivateAccountsForEmployee } from "./accounts";
import { isValidIsoDate, parseCsvTable, parseNonNegativeInteger } from "./csv";
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
import { enrollmentRequiresApproval } from "./m2";

interface CourseRow {
  id: string;
  name: string;
  competencyLevel: number;
  courseType: "mandatory" | "elective";
  durationHours: number;
  instructor: string;
  description: string;
  relatedCertificationId: string | null;
  relatedCertificationName: string | null;
  validityMonths: number | null;
  active: number;
  enrollmentOpen: number;
}

interface SpecialDayRow {
  id: string;
  specialDate: string;
  dayType: "blackout" | "mandatory_all";
  title: string;
  reason: string;
  courseSessionId: string | null;
}

interface EmployeeAssignmentRow {
  id: string;
  employeeNo: string;
  name: string;
  department: string;
  jobType: string;
  requiredLevel: number;
}

interface ConflictRow {
  employeeId: string;
  employeeName: string;
  conflictingSessionId: string;
  courseName: string;
  sessionDate: string;
  startTime: string;
  endTime: string;
}

interface CourseInput {
  name?: unknown;
  competencyLevel?: unknown;
  courseType?: unknown;
  durationHours?: unknown;
  instructor?: unknown;
  description?: unknown;
  relatedCertificationId?: unknown;
  validityMonths?: unknown;
  active?: unknown;
  enrollmentOpen?: unknown;
}

interface SessionInput {
  courseId?: unknown;
  sessionDate?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  location?: unknown;
  capacity?: unknown;
  notes?: unknown;
  selectedEmployeeIds?: unknown;
  forceConflicts?: unknown;
  conflictOverrideReason?: unknown;
  status?: unknown;
}

interface SpecialDayInput {
  specialDate?: unknown;
  dayType?: unknown;
  title?: unknown;
  reason?: unknown;
  courseSessionId?: unknown;
}

interface AttendanceInput {
  records?: unknown;
}

interface AttendanceRecordInput {
  employeeId?: unknown;
  status?: unknown;
}

const COURSE_SELECT = `
  SELECT c.id, c.name, c.competency_level AS competencyLevel,
         c.course_type AS courseType, c.duration_hours AS durationHours,
         c.instructor, c.description,
         c.related_certification_id AS relatedCertificationId,
         cert.name AS relatedCertificationName,
         c.validity_months AS validityMonths, c.active,
         c.enrollment_open AS enrollmentOpen
  FROM courses c
  LEFT JOIN certifications cert ON cert.id = c.related_certification_id
`;

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ApiError(422, `${label}須為 ${min}～${max} 的整數。`);
  }
  return value;
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ApiError(422, `${label}須為大於 0 的數字。`);
  }
  return value;
}

function booleanFlag(value: unknown, defaultValue: boolean): number {
  if (value === undefined) return defaultValue ? 1 : 0;
  if (typeof value !== "boolean") throw new ApiError(422, "布林欄位格式不正確。");
  return value ? 1 : 0;
}

function nullableId(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, label, 100);
}

function nullablePositiveInteger(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  return integer(value, label, 1, 1200);
}

function isoDate(value: unknown, label = "日期"): string {
  const text = requiredString(value, label, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new ApiError(422, `${label}格式須為 YYYY-MM-DD。`);
  }
  return text;
}

function clockTime(value: unknown, label: string): string {
  const text = requiredString(value, label, 5);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text)) {
    throw new ApiError(422, `${label}格式須為 HH:mm。`);
  }
  return text;
}

function stringArray(value: unknown, label: string): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ApiError(422, `${label}格式不正確。`);
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function parseCourse(body: CourseInput): Omit<CourseRow, "id" | "relatedCertificationName"> {
  const courseType = body.courseType === "mandatory"
    ? "mandatory"
    : body.courseType === "elective"
      ? "elective"
      : null;
  if (!courseType) throw new ApiError(422, "課程類型必須是必修或選修。");
  return {
    name: requiredString(body.name, "課程名稱", 200),
    competencyLevel: integer(body.competencyLevel, "職能級別", 1, 3),
    courseType,
    durationHours: positiveNumber(body.durationHours, "時數"),
    instructor: requiredString(body.instructor, "講師", 100),
    description: optionalString(body.description, "課程說明", 3000),
    relatedCertificationId: nullableId(body.relatedCertificationId, "關聯證照"),
    validityMonths: nullablePositiveInteger(body.validityMonths, "完成後效期"),
    active: booleanFlag(body.active, true),
    enrollmentOpen: booleanFlag(body.enrollmentOpen, false),
  };
}

async function getCourse(db: D1Database, id: string): Promise<CourseRow> {
  const course = await db.prepare(`${COURSE_SELECT} WHERE c.id = ?`).bind(id).first<CourseRow>();
  if (!course) throw new ApiError(404, "找不到指定課程。");
  return course;
}

async function getSpecialDay(db: D1Database, date: string): Promise<SpecialDayRow | null> {
  return db.prepare(`
    SELECT id, special_date AS specialDate, day_type AS dayType, title, reason,
           course_session_id AS courseSessionId
    FROM special_days WHERE special_date = ?
  `).bind(date).first<SpecialDayRow>();
}

async function activeEmployees(db: D1Database): Promise<EmployeeAssignmentRow[]> {
  const result = await db.prepare(`
    SELECT e.id, e.employee_no AS employeeNo, e.name, e.department,
           jt.name AS jobType, jt.required_level AS requiredLevel
    FROM employees e
    JOIN job_types jt ON jt.id = e.job_type_id
    WHERE e.status = 'active'
    ORDER BY e.department, e.employee_no
  `).all<EmployeeAssignmentRow>();
  return result.results;
}

function recommendedEmployeeIds(
  employees: EmployeeAssignmentRow[],
  course: CourseRow,
  specialDay: SpecialDayRow | null,
): Set<string> {
  if (specialDay?.dayType === "mandatory_all") return new Set(employees.map((employee) => employee.id));
  if (course.courseType !== "mandatory") return new Set();
  return new Set(
    employees
      .filter((employee) => employee.requiredLevel >= course.competencyLevel)
      .map((employee) => employee.id),
  );
}

async function conflictsFor(
  db: D1Database,
  employeeIds: string[],
  sessionDate: string,
  startTime: string,
  endTime: string,
  excludeSessionId?: string,
): Promise<ConflictRow[]> {
  if (employeeIds.length === 0) return [];
  const placeholders = employeeIds.map(() => "?").join(", ");
  const result = await db.prepare(`
    SELECT en.employee_id AS employeeId, e.name AS employeeName,
           cs.id AS conflictingSessionId, c.name AS courseName,
           cs.session_date AS sessionDate, cs.start_time AS startTime, cs.end_time AS endTime
    FROM enrollments en
    JOIN employees e ON e.id = en.employee_id
    JOIN course_sessions cs ON cs.id = en.course_session_id
    JOIN courses c ON c.id = cs.course_id
    WHERE en.employee_id IN (${placeholders})
      AND en.enrollment_status = 'enrolled'
      AND cs.status <> 'cancelled'
      AND cs.session_date = ?
      AND cs.start_time < ?
      AND cs.end_time > ?
      AND (? IS NULL OR cs.id <> ?)
    ORDER BY e.employee_no, cs.start_time
  `).bind(
    ...employeeIds,
    sessionDate,
    endTime,
    startTime,
    excludeSessionId ?? null,
    excludeSessionId ?? null,
  ).all<ConflictRow>();
  return result.results;
}

async function assignmentPreview(
  db: D1Database,
  input: SessionInput,
  excludeSessionId?: string,
): Promise<{
  course: CourseRow;
  specialDay: SpecialDayRow | null;
  employees: Array<EmployeeAssignmentRow & { recommended: boolean; conflicts: ConflictRow[] }>;
}> {
  const courseId = requiredString(input.courseId, "課程", 100);
  const sessionDate = isoDate(input.sessionDate);
  const startTime = clockTime(input.startTime, "開始時間");
  const endTime = clockTime(input.endTime, "結束時間");
  if (startTime >= endTime) throw new ApiError(422, "結束時間必須晚於開始時間。");

  const [course, specialDay, employees] = await Promise.all([
    getCourse(db, courseId),
    getSpecialDay(db, sessionDate),
    activeEmployees(db),
  ]);
  if (specialDay?.dayType === "blackout") {
    throw new ApiError(422, `此日為封鎖日「${specialDay.title}」：${specialDay.reason || "不可排課"}`);
  }
  const recommended = recommendedEmployeeIds(employees, course, specialDay);
  const conflicts = await conflictsFor(
    db,
    employees.map((employee) => employee.id),
    sessionDate,
    startTime,
    endTime,
    excludeSessionId,
  );
  return {
    course,
    specialDay,
    employees: employees.map((employee) => ({
      ...employee,
      recommended: recommended.has(employee.id),
      conflicts: conflicts.filter((conflict) => conflict.employeeId === employee.id),
    })),
  };
}

async function listCourses(context: ApiContext): Promise<Response> {
  const includeInactive = context.url.searchParams.get("includeInactive") === "true";
  const result = await context.env.DB.prepare(`
    ${COURSE_SELECT}
    ${includeInactive ? "" : "WHERE c.active = 1"}
    ORDER BY c.competency_level, c.name
  `).all<CourseRow>();
  return json({ courses: result.results });
}

async function createCourse(context: ApiContext): Promise<Response> {
  const course = parseCourse(await parseJson<CourseInput>(context.request));
  const id = uuid();
  await context.env.DB.prepare(`
    INSERT INTO courses (
      id, name, competency_level, course_type, duration_hours, instructor, description,
      related_certification_id, validity_months, active, enrollment_open
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, course.name, course.competencyLevel, course.courseType, course.durationHours,
    course.instructor, course.description, course.relatedCertificationId,
    course.validityMonths, course.active, course.enrollmentOpen,
  ).run();
  return json({ course: await getCourse(context.env.DB, id) }, 201);
}

async function updateCourse(context: ApiContext, id: string): Promise<Response> {
  await getCourse(context.env.DB, id);
  const course = parseCourse(await parseJson<CourseInput>(context.request));
  await context.env.DB.prepare(`
    UPDATE courses SET name = ?, competency_level = ?, course_type = ?, duration_hours = ?,
      instructor = ?, description = ?, related_certification_id = ?, validity_months = ?,
      active = ?, enrollment_open = ? WHERE id = ?
  `).bind(
    course.name, course.competencyLevel, course.courseType, course.durationHours,
    course.instructor, course.description, course.relatedCertificationId,
    course.validityMonths, course.active, course.enrollmentOpen, id,
  ).run();
  return json({ course: await getCourse(context.env.DB, id) });
}

async function archiveCourse(context: ApiContext, id: string): Promise<Response> {
  const result = await context.env.DB.prepare("UPDATE courses SET active = 0 WHERE id = ?").bind(id).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定課程。");
  return json({ id, archived: true });
}

async function listSpecialDays(context: ApiContext): Promise<Response> {
  const month = context.url.searchParams.get("month");
  const where = month && /^\d{4}-\d{2}$/.test(month)
    ? "WHERE special_date >= ? AND special_date < date(?, '+1 month')"
    : "";
  const statement = context.env.DB.prepare(`
    SELECT id, special_date AS specialDate, day_type AS dayType, title, reason,
           course_session_id AS courseSessionId
    FROM special_days ${where} ORDER BY special_date
  `);
  const result = month && where ? await statement.bind(`${month}-01`, `${month}-01`).all<SpecialDayRow>() : await statement.all<SpecialDayRow>();
  return json({ specialDays: result.results });
}

function parseSpecialDay(body: SpecialDayInput): Omit<SpecialDayRow, "id"> {
  const dayType = body.dayType === "blackout"
    ? "blackout"
    : body.dayType === "mandatory_all"
      ? "mandatory_all"
      : null;
  if (!dayType) throw new ApiError(422, "重要日子類型不正確。");
  return {
    specialDate: isoDate(body.specialDate),
    dayType,
    title: requiredString(body.title, "名稱", 200),
    reason: optionalString(body.reason, "原因", 1000),
    courseSessionId: nullableId(body.courseSessionId, "指定場次"),
  };
}

async function createSpecialDay(context: ApiContext, admin: AuthUser): Promise<Response> {
  const day = parseSpecialDay(await parseJson<SpecialDayInput>(context.request));
  const existingSession = await context.env.DB.prepare(
    "SELECT id FROM course_sessions WHERE session_date = ? AND status <> 'cancelled' LIMIT 1",
  ).bind(day.specialDate).first();
  if (day.dayType === "blackout" && existingSession) {
    throw new ApiError(409, "此日已有排課場次，請先取消或移動場次後再設為封鎖日。");
  }
  const id = uuid();
  try {
    await context.env.DB.prepare(`
      INSERT INTO special_days (id, special_date, day_type, title, reason, course_session_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(id, day.specialDate, day.dayType, day.title, day.reason, day.courseSessionId, admin.id).run();
  } catch {
    throw new ApiError(409, "此日期已有重要日子設定。");
  }
  return json({ specialDay: { id, ...day } }, 201);
}

async function updateSpecialDay(context: ApiContext, id: string): Promise<Response> {
  const day = parseSpecialDay(await parseJson<SpecialDayInput>(context.request));
  const existingSession = await context.env.DB.prepare(
    "SELECT id FROM course_sessions WHERE session_date = ? AND status <> 'cancelled' LIMIT 1",
  ).bind(day.specialDate).first();
  if (day.dayType === "blackout" && existingSession) {
    throw new ApiError(409, "此日已有排課場次，無法設為封鎖日。");
  }
  try {
    const result = await context.env.DB.prepare(`
      UPDATE special_days SET special_date = ?, day_type = ?, title = ?, reason = ?, course_session_id = ?
      WHERE id = ?
    `).bind(day.specialDate, day.dayType, day.title, day.reason, day.courseSessionId, id).run();
    if (result.meta.changes === 0) throw new ApiError(404, "找不到指定的重要日子。");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(409, "此日期已有重要日子設定。");
  }
  return json({ specialDay: { id, ...day } });
}

async function deleteSpecialDay(context: ApiContext, id: string): Promise<Response> {
  const result = await context.env.DB.prepare("DELETE FROM special_days WHERE id = ?").bind(id).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定的重要日子。");
  return json({ id, deleted: true });
}

async function listCalendar(context: ApiContext): Promise<Response> {
  const month = context.url.searchParams.get("month");
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    throw new ApiError(422, "month 參數格式須為 YYYY-MM。");
  }
  const start = `${month}-01`;
  const [sessions, days] = await Promise.all([
    context.env.DB.prepare(`
      SELECT cs.id, cs.course_id AS courseId, c.name AS courseName,
             c.competency_level AS competencyLevel, c.course_type AS courseType,
             cs.session_date AS sessionDate, cs.start_time AS startTime, cs.end_time AS endTime,
             cs.location, cs.capacity, cs.notes, cs.status,
             COUNT(CASE WHEN en.enrollment_status = 'enrolled' THEN 1 END) AS enrolledCount
      FROM course_sessions cs
      JOIN courses c ON c.id = cs.course_id
      LEFT JOIN enrollments en ON en.course_session_id = cs.id
      WHERE cs.session_date >= ? AND cs.session_date < date(?, '+1 month')
      GROUP BY cs.id
      ORDER BY cs.session_date, cs.start_time
    `).bind(start, start).all(),
    context.env.DB.prepare(`
      SELECT id, special_date AS specialDate, day_type AS dayType, title, reason,
             course_session_id AS courseSessionId
      FROM special_days
      WHERE special_date >= ? AND special_date < date(?, '+1 month')
      ORDER BY special_date
    `).bind(start, start).all<SpecialDayRow>(),
  ]);
  return json({ sessions: sessions.results, specialDays: days.results });
}

async function listSessions(context: ApiContext): Promise<Response> {
  const status = context.url.searchParams.get("status");
  const where = status ? "WHERE cs.status = ?" : "";
  const statement = context.env.DB.prepare(`
    SELECT cs.id, cs.course_id AS courseId, c.name AS courseName,
           c.competency_level AS competencyLevel, c.course_type AS courseType,
           cs.session_date AS sessionDate, cs.start_time AS startTime, cs.end_time AS endTime,
           cs.location, cs.capacity, cs.notes, cs.status,
           COUNT(CASE WHEN en.enrollment_status = 'enrolled' THEN 1 END) AS enrolledCount
    FROM course_sessions cs
    JOIN courses c ON c.id = cs.course_id
    LEFT JOIN enrollments en ON en.course_session_id = cs.id
    ${where}
    GROUP BY cs.id ORDER BY cs.session_date DESC, cs.start_time
  `);
  const result = status ? await statement.bind(status).all() : await statement.all();
  return json({ sessions: result.results });
}

function parseSessionFields(body: SessionInput): {
  courseId: string;
  sessionDate: string;
  startTime: string;
  endTime: string;
  location: string;
  capacity: number;
  notes: string;
  selectedEmployeeIds: string[] | null;
  forceConflicts: boolean;
  conflictOverrideReason: string;
} {
  const startTime = clockTime(body.startTime, "開始時間");
  const endTime = clockTime(body.endTime, "結束時間");
  if (startTime >= endTime) throw new ApiError(422, "結束時間必須晚於開始時間。");
  return {
    courseId: requiredString(body.courseId, "課程", 100),
    sessionDate: isoDate(body.sessionDate),
    startTime,
    endTime,
    location: requiredString(body.location, "地點", 200),
    capacity: integer(body.capacity, "名額上限", 1, 10000),
    notes: optionalString(body.notes, "備註", 2000),
    selectedEmployeeIds: stringArray(body.selectedEmployeeIds, "指派員工"),
    forceConflicts: body.forceConflicts === true,
    conflictOverrideReason: optionalString(body.conflictOverrideReason, "強制覆寫原因", 1000),
  };
}

async function createSession(context: ApiContext, admin: AuthUser): Promise<Response> {
  const body = await parseJson<SessionInput>(context.request);
  const fields = parseSessionFields(body);
  const preview = await assignmentPreview(context.env.DB, fields);
  const recommended = new Set(
    preview.employees.filter((employee) => employee.recommended).map((employee) => employee.id),
  );
  const selected = fields.selectedEmployeeIds ?? [...recommended];
  const activeIds = new Set(preview.employees.map((employee) => employee.id));
  if (selected.some((id) => !activeIds.has(id))) {
    throw new ApiError(422, "指派名單包含非在職或不存在的員工。");
  }
  if (selected.length > fields.capacity) {
    throw new ApiError(422, `指派人數 ${selected.length} 超過名額上限 ${fields.capacity}。`);
  }
  const conflicts = await conflictsFor(
    context.env.DB,
    selected,
    fields.sessionDate,
    fields.startTime,
    fields.endTime,
  );
  if (conflicts.length > 0 && !fields.forceConflicts) {
    throw new ApiError(409, "指派名單有時段衝突，請調整名單或確認強制覆寫。", { conflicts });
  }
  if (conflicts.length > 0 && !fields.conflictOverrideReason) {
    throw new ApiError(422, "強制覆寫衝突時必須填寫原因。");
  }

  const id = uuid();
  const statements: D1PreparedStatement[] = [
    context.env.DB.prepare(`
      INSERT INTO course_sessions (
        id, course_id, session_date, start_time, end_time, location, capacity, notes, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, fields.courseId, fields.sessionDate, fields.startTime, fields.endTime,
      fields.location, fields.capacity, fields.notes, admin.id,
    ),
  ];
  const conflictEmployees = new Set(conflicts.map((conflict) => conflict.employeeId));
  for (const employeeId of selected) {
    statements.push(context.env.DB.prepare(`
      INSERT INTO enrollments (
        id, course_session_id, employee_id, source, conflict_override, conflict_reason
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      uuid(), id, employeeId, recommended.has(employeeId) ? "auto" : "manual",
      conflictEmployees.has(employeeId) ? 1 : 0,
      conflictEmployees.has(employeeId) ? fields.conflictOverrideReason : null,
    ));
  }
  for (const conflict of conflicts) {
    statements.push(context.env.DB.prepare(`
      INSERT INTO conflict_overrides (
        id, employee_id, new_session_id, conflicting_session_id, reason, overridden_by
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      uuid(), conflict.employeeId, id, conflict.conflictingSessionId,
      fields.conflictOverrideReason, admin.id,
    ));
  }
  if (preview.specialDay?.dayType === "mandatory_all") {
    statements.push(context.env.DB.prepare(
      "UPDATE special_days SET course_session_id = ? WHERE id = ?",
    ).bind(id, preview.specialDay.id));
  }
  statements.push(context.env.DB.prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, details)
    VALUES (?, ?, 'course_session.create', 'course_session', ?, ?)
  `).bind(
    uuid(), admin.id, id,
    JSON.stringify({ assignedCount: selected.length, forcedConflictCount: conflicts.length }),
  ));
  await context.env.DB.batch(statements);
  return json({ id, assignedCount: selected.length, conflicts }, 201);
}

async function updateSession(context: ApiContext, admin: AuthUser, id: string): Promise<Response> {
  const existing = await context.env.DB.prepare(
    "SELECT id, status FROM course_sessions WHERE id = ?",
  ).bind(id).first<{ id: string; status: string }>();
  if (!existing) throw new ApiError(404, "找不到指定場次。");
  if (existing.status === "completed") {
    throw new ApiError(409, "已完成的場次不可修改排課內容；如需更正請調整出席紀錄。");
  }
  const body = await parseJson<SessionInput>(context.request);
  const fields = parseSessionFields(body);
  const preview = await assignmentPreview(context.env.DB, fields, id);
  const current = await context.env.DB.prepare(`
    SELECT employee_id AS employeeId FROM enrollments
    WHERE course_session_id = ? AND enrollment_status = 'enrolled'
  `).bind(id).all<{ employeeId: string }>();
  const selected = fields.selectedEmployeeIds ?? current.results.map((row) => row.employeeId);
  if (selected.length > fields.capacity) {
    throw new ApiError(422, `指派人數 ${selected.length} 超過名額上限 ${fields.capacity}。`);
  }
  const activeIds = new Set(preview.employees.map((employee) => employee.id));
  if (selected.some((employeeId) => !activeIds.has(employeeId))) {
    throw new ApiError(422, "指派名單包含非在職或不存在的員工。");
  }
  const conflicts = await conflictsFor(
    context.env.DB,
    selected,
    fields.sessionDate,
    fields.startTime,
    fields.endTime,
    id,
  );
  if (conflicts.length && !fields.forceConflicts) {
    throw new ApiError(409, "更新後會發生時段衝突。", { conflicts });
  }
  if (conflicts.length && !fields.conflictOverrideReason) {
    throw new ApiError(422, "強制覆寫衝突時必須填寫原因。");
  }

  const recommended = new Set(
    preview.employees.filter((employee) => employee.recommended).map((employee) => employee.id),
  );
  const conflictEmployees = new Set(conflicts.map((conflict) => conflict.employeeId));
  const statements: D1PreparedStatement[] = [
    context.env.DB.prepare(`
      UPDATE course_sessions SET course_id = ?, session_date = ?, start_time = ?, end_time = ?,
        location = ?, capacity = ?, notes = ?, status = ? WHERE id = ?
    `).bind(
      fields.courseId, fields.sessionDate, fields.startTime, fields.endTime, fields.location,
      fields.capacity, fields.notes,
      body.status === "cancelled" ? body.status : "scheduled",
      id,
    ),
    context.env.DB.prepare("DELETE FROM enrollments WHERE course_session_id = ?").bind(id),
    context.env.DB.prepare("DELETE FROM conflict_overrides WHERE new_session_id = ?").bind(id),
  ];
  for (const employeeId of selected) {
    statements.push(context.env.DB.prepare(`
      INSERT INTO enrollments (
        id, course_session_id, employee_id, source, conflict_override, conflict_reason
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      uuid(), id, employeeId, recommended.has(employeeId) ? "auto" : "manual",
      conflictEmployees.has(employeeId) ? 1 : 0,
      conflictEmployees.has(employeeId) ? fields.conflictOverrideReason : null,
    ));
  }
  for (const conflict of conflicts) {
    statements.push(context.env.DB.prepare(`
      INSERT INTO conflict_overrides (
        id, employee_id, new_session_id, conflicting_session_id, reason, overridden_by
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      uuid(), conflict.employeeId, id, conflict.conflictingSessionId,
      fields.conflictOverrideReason, admin.id,
    ));
  }
  await context.env.DB.batch(statements);
  return json({ id, assignedCount: selected.length, conflicts });
}

async function cancelSession(context: ApiContext, id: string): Promise<Response> {
  const result = await context.env.DB.batch([
    context.env.DB.prepare("UPDATE course_sessions SET status = 'cancelled' WHERE id = ?").bind(id),
    context.env.DB.prepare(`
      UPDATE enrollments SET enrollment_status = 'cancelled'
      WHERE course_session_id = ? AND attendance_status = 'pending'
    `).bind(id),
  ]);
  if (result[0]?.meta.changes === 0) throw new ApiError(404, "找不到指定場次。");
  return json({ id, cancelled: true });
}

export function taipeiNow(): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts();
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}`;
}

async function getAttendance(context: ApiContext, id: string): Promise<Response> {
  const session = await context.env.DB.prepare(`
    SELECT cs.id, c.name AS courseName, cs.session_date AS sessionDate,
           cs.start_time AS startTime, cs.end_time AS endTime, cs.location, cs.status
    FROM course_sessions cs JOIN courses c ON c.id = cs.course_id WHERE cs.id = ?
  `).bind(id).first();
  if (!session) throw new ApiError(404, "找不到指定場次。");
  const records = await context.env.DB.prepare(`
    SELECT en.employee_id AS employeeId, e.employee_no AS employeeNo, e.name, e.department,
           en.source, en.attendance_status AS attendanceStatus,
           en.conflict_override AS conflictOverride
    FROM enrollments en JOIN employees e ON e.id = en.employee_id
    WHERE en.course_session_id = ? AND en.enrollment_status = 'enrolled'
    ORDER BY e.department, e.employee_no
  `).bind(id).all();
  return json({ session, records: records.results });
}

async function recordAttendance(context: ApiContext, id: string): Promise<Response> {
  const body = await parseJson<AttendanceInput>(context.request);
  if (!Array.isArray(body.records) || body.records.length === 0) {
    throw new ApiError(422, "請提供至少一筆出席紀錄。");
  }
  const session = await context.env.DB.prepare(`
    SELECT cs.id, cs.session_date AS sessionDate, cs.end_time AS endTime
    FROM course_sessions cs WHERE cs.id = ? AND cs.status <> 'cancelled'
  `).bind(id).first<{ id: string; sessionDate: string; endTime: string }>();
  if (!session) throw new ApiError(404, "找不到可登錄的場次。");
  if (`${session.sessionDate}T${session.endTime}` > taipeiNow()) {
    throw new ApiError(422, "場次尚未結束，無法登錄出席。");
  }

  const records = body.records as AttendanceRecordInput[];
  const normalized = records.map((record) => {
    const employeeId = requiredString(record.employeeId, "員工", 100);
    const status = record.status === "completed" || record.status === "absent" || record.status === "leave"
      ? record.status
      : null;
    if (!status) throw new ApiError(422, "出席狀態須為完成、缺席或請假。");
    return { employeeId, status };
  });
  const enrolled = await context.env.DB.prepare(`
    SELECT employee_id AS employeeId, id AS enrollmentId
    FROM enrollments WHERE course_session_id = ? AND enrollment_status = 'enrolled'
  `).bind(id).all<{ employeeId: string; enrollmentId: string }>();
  const enrollmentMap = new Map(enrolled.results.map((row) => [row.employeeId, row.enrollmentId]));
  if (normalized.some((record) => !enrollmentMap.has(record.employeeId))) {
    throw new ApiError(422, "出席名單包含未報名此場次的員工。");
  }

  const statements: D1PreparedStatement[] = [];
  for (const record of normalized) {
    const enrollmentId = enrollmentMap.get(record.employeeId);
    statements.push(context.env.DB.prepare(`
      UPDATE enrollments SET attendance_status = ?,
        attended_at = CASE WHEN ? = 'completed' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END,
        completed_at = CASE WHEN ? = 'completed' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END
      WHERE id = ?
    `).bind(record.status, record.status, record.status, enrollmentId));
    if (record.status === "completed") {
      statements.push(context.env.DB.prepare(`
        INSERT INTO training_records (
          id, employee_id, course_id, course_session_id, enrollment_id,
          completed_at, hours, valid_until
        )
        SELECT ?, en.employee_id, cs.course_id, cs.id, en.id,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), c.duration_hours,
          CASE WHEN c.validity_months IS NULL THEN NULL
               ELSE date('now', '+' || c.validity_months || ' months') END
        FROM enrollments en
        JOIN course_sessions cs ON cs.id = en.course_session_id
        JOIN courses c ON c.id = cs.course_id
        WHERE en.id = ?
        ON CONFLICT(enrollment_id) DO UPDATE SET
          completed_at = excluded.completed_at, hours = excluded.hours, valid_until = excluded.valid_until
      `).bind(uuid(), enrollmentId));
    } else {
      statements.push(context.env.DB.prepare(
        "DELETE FROM training_records WHERE enrollment_id = ?",
      ).bind(enrollmentId));
    }
  }
  await context.env.DB.batch(statements);
  const pending = await context.env.DB.prepare(`
    SELECT COUNT(*) AS count FROM enrollments
    WHERE course_session_id = ? AND enrollment_status = 'enrolled' AND attendance_status = 'pending'
  `).bind(id).first<{ count: number }>();
  if ((pending?.count ?? 0) === 0) {
    await context.env.DB.prepare("UPDATE course_sessions SET status = 'completed' WHERE id = ?").bind(id).run();
  }
  return getAttendance(context, id);
}

interface CompletionEmployee {
  id: string;
  employeeNo: string;
  name: string;
  department: string;
  grade: string;
  jobType: string;
  requiredLevel: number;
}

interface RequiredCourse {
  id: string;
  name: string;
  competencyLevel: number;
}

export interface CompletionRow extends CompletionEmployee {
  requiredCount: number;
  completedCount: number;
  completionRate: number;
  missingCourses: RequiredCourse[];
}

/** M4 報表需要職等與「截至某日」的完成狀態，故以選項物件取代位置參數。 */
export interface CompletionFilters {
  department?: string | null;
  employeeId?: string | null;
  grade?: string | null;
  /** 只採計此日期（不含）之前完成的訓練紀錄，用於「截至期末」口徑。 */
  completedBefore?: string | null;
}

export async function completionData(
  db: D1Database,
  filters: CompletionFilters = {},
): Promise<CompletionRow[]> {
  const conditions = ["e.status = 'active'"];
  const bindings: string[] = [];
  if (filters.department) {
    conditions.push("e.department = ?");
    bindings.push(filters.department);
  }
  if (filters.grade) {
    conditions.push("e.grade = ?");
    bindings.push(filters.grade);
  }
  if (filters.employeeId) {
    conditions.push("e.id = ?");
    bindings.push(filters.employeeId);
  }
  const employees = await db.prepare(`
    SELECT e.id, e.employee_no AS employeeNo, e.name, e.department, e.grade,
           jt.name AS jobType, jt.required_level AS requiredLevel
    FROM employees e JOIN job_types jt ON jt.id = e.job_type_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY e.department, e.employee_no
  `).bind(...bindings).all<CompletionEmployee>();
  const recordStatement = filters.completedBefore
    ? db.prepare(`
      SELECT DISTINCT employee_id AS employeeId, course_id AS courseId
      FROM training_records WHERE completed_at < ?
    `).bind(filters.completedBefore)
    : db.prepare(`
      SELECT DISTINCT employee_id AS employeeId, course_id AS courseId
      FROM training_records
    `);
  const [courses, records] = await Promise.all([
    db.prepare(`
      SELECT id, name, competency_level AS competencyLevel
      FROM courses WHERE active = 1 AND course_type = 'mandatory'
      ORDER BY competency_level, name
    `).all<RequiredCourse>(),
    recordStatement.all<{ employeeId: string; courseId: string }>(),
  ]);
  const completed = new Set(records.results.map((record) => `${record.employeeId}:${record.courseId}`));
  return employees.results.map((employee) => {
    const required = courses.results.filter((course) => course.competencyLevel <= employee.requiredLevel);
    const completedCount = required.filter((course) => completed.has(`${employee.id}:${course.id}`)).length;
    return {
      ...employee,
      requiredCount: required.length,
      completedCount,
      completionRate: required.length === 0 ? 100 : Math.round((completedCount / required.length) * 100),
      missingCourses: required
        .filter((course) => !completed.has(`${employee.id}:${course.id}`))
        .map((course) => ({ id: course.id, name: course.name, competencyLevel: course.competencyLevel })),
    };
  });
}

async function completionTracking(context: ApiContext): Promise<Response> {
  const department = context.url.searchParams.get("department") || undefined;
  const employees = await completionData(context.env.DB, { department });
  const departments = await context.env.DB.prepare(`
    SELECT DISTINCT department FROM employees WHERE status = 'active' ORDER BY department
  `).all<{ department: string }>();
  return json({ employees, departments: departments.results.map((row) => row.department) });
}

/**
 * 員工主檔清單（供員工管理頁使用）。
 *
 * 刻意不共用 `activeEmployees()`：那支只回排課指派需要的 6 個欄位且固定只取在職者，
 * 同時被場次指派邏輯使用（見 :283），改動它會連帶影響應上名單的計算。
 * 員工管理頁需要完整欄位才能送出 PATCH（後端採整筆取代語意），也需要看得到離職者。
 *
 * 回傳欄位是 `activeEmployees()` 的超集合，既有呼叫端不受影響。
 * `?includeInactive=true` 才會帶出離職者，預設維持只回在職，避免改變既有行為。
 */
/**
 * 員工主檔清單（供員工管理頁使用）。
 *
 * 刻意不共用 `activeEmployees()`：那支只回排課指派需要的 6 個欄位且固定只取在職者，
 * 同時被場次指派邏輯使用（見 :283），改動它會連帶影響應上名單的計算。
 * 員工管理頁需要完整欄位才能送出 PATCH（後端採整筆取代語意），也需要看得到離職者。
 *
 * 回傳欄位是 `activeEmployees()` 的超集合，既有呼叫端不受影響。
 * `?includeInactive=true` 才會帶出離職者，預設維持只回在職，避免改變既有行為。
 */
async function listEmployees(context: ApiContext): Promise<Response> {
  const includeInactive = new URL(context.request.url).searchParams.get("includeInactive") === "true";
  const result = await context.env.DB.prepare(`
    SELECT e.id, e.employee_no AS employeeNo, e.name, e.email, e.department,
           e.grade, e.title, e.job_type_id AS jobTypeId,
           jt.name AS jobType, jt.required_level AS requiredLevel,
           e.hire_date AS hireDate, e.birth_date AS birthDate,
           e.termination_date AS terminationDate,
           e.status, e.salary
    FROM employees e
    JOIN job_types jt ON jt.id = e.job_type_id
    ${includeInactive ? "" : "WHERE e.status = 'active'"}
    ORDER BY e.status, e.department, e.employee_no
  `).all();
  return json({ employees: result.results });
}

const EMPLOYEE_CSV_HEADERS = [
  "員工編號", "姓名", "Email", "部門", "職等", "職稱", "職務類型", "到職日", "薪資",
] as const;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface EmployeeInput {
  employeeNo?: unknown;
  name?: unknown;
  email?: unknown;
  department?: unknown;
  grade?: unknown;
  title?: unknown;
  jobTypeId?: unknown;
  hireDate?: unknown;
  birthDate?: unknown;
  terminationDate?: unknown;
  status?: unknown;
  salary?: unknown;
}

interface EmployeeFields {
  employeeNo: string;
  name: string;
  email: string;
  department: string;
  grade: string;
  title: string;
  jobTypeId: string;
  hireDate: string;
  /** 健檢頻率依《勞工健康保護規則》的年齡級距計算，故需生日；既有資料可能沒有，允許為空。 */
  birthDate: string | null;
  terminationDate: string | null;
  status: "active" | "inactive";
  salary: number | null;
}

interface EmployeeRecord extends EmployeeFields {
  id: string;
  jobType: string;
}

function nullableSalary(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ApiError(422, "薪資須為非負整數。");
  }
  return value;
}

/**
 * 員工主檔建立／更新共用驗證。PATCH 與 updateCourse 等既有寫法一致，採全量取代而非局部合併。
 * status 省略時預設為在職（新進員工最常見情境）；設為 inactive 時要求填 terminationDate，
 * 設為 active 時一律清空 terminationDate（即使呼叫端仍夾帶舊值），避免離職日殘留使報表誤判在職狀態。
 */
function parseEmployee(body: EmployeeInput): EmployeeFields {
  const status = body.status === undefined || body.status === null || body.status === ""
    ? "active"
    : body.status === "active" || body.status === "inactive"
      ? body.status
      : null;
  if (!status) throw new ApiError(422, "員工狀態必須是在職或離職。");

  const email = requiredString(body.email, "Email", 200);
  if (!EMAIL_PATTERN.test(email)) throw new ApiError(422, "Email 格式不正確。");

  const hireDate = isoDate(body.hireDate, "到職日");
  const providedTerminationDate = body.terminationDate === undefined
    || body.terminationDate === null
    || body.terminationDate === ""
    ? null
    : isoDate(body.terminationDate, "離職日");
  if (status === "inactive" && !providedTerminationDate) {
    throw new ApiError(422, "離職狀態須填寫離職日。");
  }

  return {
    employeeNo: requiredString(body.employeeNo, "員工編號", 50),
    name: requiredString(body.name, "姓名", 100),
    email,
    department: requiredString(body.department, "部門", 100),
    grade: requiredString(body.grade, "職等", 50),
    title: requiredString(body.title, "職稱", 100),
    jobTypeId: requiredString(body.jobTypeId, "職務類型", 100),
    hireDate,
    // 生日可留空：既有員工資料未必有，健檢模組會將其標為「待補生日」而非套用預設間隔。
    birthDate: body.birthDate === undefined || body.birthDate === null || body.birthDate === ""
      ? null
      : isoDate(body.birthDate, "生日"),
    terminationDate: status === "active" ? null : providedTerminationDate,
    status,
    salary: nullableSalary(body.salary),
  };
}

async function ensureJobType(db: D1Database, jobTypeId: string): Promise<void> {
  const jobType = await db.prepare("SELECT id FROM job_types WHERE id = ?").bind(jobTypeId).first();
  if (!jobType) throw new ApiError(422, "找不到指定的職務類型。");
}

async function assertEmployeeNoAvailable(db: D1Database, employeeNo: string, excludeId?: string): Promise<void> {
  const existing = excludeId
    ? await db.prepare("SELECT id FROM employees WHERE employee_no = ? AND id <> ?")
      .bind(employeeNo, excludeId).first<{ id: string }>()
    : await db.prepare("SELECT id FROM employees WHERE employee_no = ?")
      .bind(employeeNo).first<{ id: string }>();
  if (existing) throw new ApiError(409, `員工編號「${employeeNo}」已被使用。`);
}

async function assertEmailAvailable(db: D1Database, email: string, excludeId?: string): Promise<void> {
  const existing = excludeId
    ? await db.prepare("SELECT id FROM employees WHERE email = ? COLLATE NOCASE AND id <> ?")
      .bind(email, excludeId).first<{ id: string }>()
    : await db.prepare("SELECT id FROM employees WHERE email = ? COLLATE NOCASE")
      .bind(email).first<{ id: string }>();
  if (existing) throw new ApiError(409, `Email「${email}」已被其他員工使用。`);
}

async function getEmployeeRecord(db: D1Database, id: string): Promise<EmployeeRecord> {
  const row = await db.prepare(`
    SELECT e.id, e.employee_no AS employeeNo, e.name, e.email, e.department, e.grade, e.title,
           e.job_type_id AS jobTypeId, jt.name AS jobType, e.hire_date AS hireDate,
           e.birth_date AS birthDate,
           e.termination_date AS terminationDate, e.status, e.salary
    FROM employees e JOIN job_types jt ON jt.id = e.job_type_id
    WHERE e.id = ?
  `).bind(id).first<EmployeeRecord>();
  if (!row) throw new ApiError(404, "找不到指定員工。");
  return row;
}

/** 建立員工主檔（規格 §七 員工管理）。job_type_id 須對應既有值，employee_no／email 須唯一。 */
async function createEmployee(context: ApiContext): Promise<Response> {
  const fields = parseEmployee(await parseJson<EmployeeInput>(context.request));
  await ensureJobType(context.env.DB, fields.jobTypeId);
  await assertEmployeeNoAvailable(context.env.DB, fields.employeeNo);
  await assertEmailAvailable(context.env.DB, fields.email);
  const id = uuid();
  await context.env.DB.prepare(`
    INSERT INTO employees (
      id, employee_no, name, email, department, grade, title, job_type_id,
      hire_date, birth_date, termination_date, status, salary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, fields.employeeNo, fields.name, fields.email, fields.department, fields.grade,
    fields.title, fields.jobTypeId, fields.hireDate, fields.birthDate,
    fields.terminationDate, fields.status, fields.salary,
  ).run();
  return json({ employee: await getEmployeeRecord(context.env.DB, id) }, 201);
}

/**
 * 更新員工主檔。離職透過此端點設定 status='inactive' + terminationDate 完成，
 * 不提供實體刪除（規格與人資領域慣例：保留歷史關聯，見 enrollments／training_records）。
 *
 * 存取控制連動（重要）：標記離職時一併停用其登入帳號並刪除既有 sessions
 * （見 accounts.ts deactivateAccountsForEmployee）。在此之前離職者仍可登入查看
 * 自己的訓練紀錄與 IDP、報名課程，是實質的存取控制缺陷。
 * 反向（復職）刻意不自動啟用帳號，須由 admin 明確操作。
 */
async function updateEmployee(context: ApiContext, id: string): Promise<Response> {
  const fields = parseEmployee(await parseJson<EmployeeInput>(context.request));
  await ensureJobType(context.env.DB, fields.jobTypeId);
  await assertEmployeeNoAvailable(context.env.DB, fields.employeeNo, id);
  await assertEmailAvailable(context.env.DB, fields.email, id);
  // 與 accounts.ts「不可自我停權」同一條規則：標記自己離職會連帶停用自己正在用的帳號。
  if (fields.status === "inactive" && context.user?.employeeId === id) {
    throw new ApiError(422, "不可將自己標記為離職，這會停用您正在使用的登入帳號。請由另一位管理員操作。");
  }
  const result = await context.env.DB.prepare(`
    UPDATE employees SET employee_no = ?, name = ?, email = ?, department = ?, grade = ?, title = ?,
      job_type_id = ?, hire_date = ?, birth_date = ?, termination_date = ?, status = ?, salary = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).bind(
    fields.employeeNo, fields.name, fields.email, fields.department, fields.grade, fields.title,
    fields.jobTypeId, fields.hireDate, fields.birthDate,
    fields.terminationDate, fields.status, fields.salary, id,
  ).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定員工。");
  const deactivatedAccounts = fields.status === "inactive"
    ? await deactivateAccountsForEmployee(context.env.DB, id)
    : 0;
  return json({
    employee: await getEmployeeRecord(context.env.DB, id),
    deactivatedAccounts,
  });
}

// ---------------------------------------------------------------------------
// 職務類型管理（規格 §四 4.1／§七 系統設定：職務類型與必修級距映射做成資料表，不寫死）
// ---------------------------------------------------------------------------

interface JobTypeInput {
  name?: unknown;
  requiredLevel?: unknown;
  active?: unknown;
}

interface JobTypeRecord {
  id: string;
  name: string;
  requiredLevel: number;
  active: number;
  employeeCount: number;
}

function parseJobType(body: JobTypeInput): { name: string; requiredLevel: number; active: number } {
  return {
    name: requiredString(body.name, "職務類型名稱", 100),
    requiredLevel: integer(body.requiredLevel, "必修級距", 1, 3),
    active: booleanFlag(body.active, true),
  };
}

async function assertJobTypeNameAvailable(db: D1Database, name: string, excludeId?: string): Promise<void> {
  const existing = excludeId
    ? await db.prepare("SELECT id FROM job_types WHERE name = ? AND id <> ?")
      .bind(name, excludeId).first<{ id: string }>()
    : await db.prepare("SELECT id FROM job_types WHERE name = ?")
      .bind(name).first<{ id: string }>();
  if (existing) throw new ApiError(409, `職務類型「${name}」已存在。`);
}

async function getJobTypeRecord(db: D1Database, id: string): Promise<JobTypeRecord> {
  const row = await db.prepare(`
    SELECT jt.id, jt.name, jt.required_level AS requiredLevel, jt.active,
           (SELECT COUNT(*) FROM employees e WHERE e.job_type_id = jt.id) AS employeeCount
    FROM job_types jt WHERE jt.id = ?
  `).bind(id).first<JobTypeRecord>();
  if (!row) throw new ApiError(404, "找不到指定職務類型。");
  return row;
}

/**
 * required_level 是排課指派（見 :202 activeEmployees／:214 recommendedEmployeeIds）用來比對
 * 課程 competencyLevel 的必修級距依據。改動只影響「之後」計算的應上名單；已建立場次時寫入
 * enrollments 的名單不會回溯重算，需要的話得由 admin 手動調整既有場次的名單。
 */
async function listJobTypes(context: ApiContext): Promise<Response> {
  const result = await context.env.DB.prepare(`
    SELECT jt.id, jt.name, jt.required_level AS requiredLevel, jt.active,
           (SELECT COUNT(*) FROM employees e WHERE e.job_type_id = jt.id) AS employeeCount
    FROM job_types jt
    ORDER BY jt.required_level, jt.name
  `).all<JobTypeRecord>();
  return json({ jobTypes: result.results });
}

async function createJobType(context: ApiContext): Promise<Response> {
  const fields = parseJobType(await parseJson<JobTypeInput>(context.request));
  await assertJobTypeNameAvailable(context.env.DB, fields.name);
  const id = uuid();
  await context.env.DB.prepare(`
    INSERT INTO job_types (id, name, required_level, active) VALUES (?, ?, ?, ?)
  `).bind(id, fields.name, fields.requiredLevel, fields.active).run();
  return json({ jobType: await getJobTypeRecord(context.env.DB, id) }, 201);
}

async function updateJobType(context: ApiContext, id: string): Promise<Response> {
  const fields = parseJobType(await parseJson<JobTypeInput>(context.request));
  await assertJobTypeNameAvailable(context.env.DB, fields.name, id);
  const result = await context.env.DB.prepare(`
    UPDATE job_types SET name = ?, required_level = ?, active = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).bind(fields.name, fields.requiredLevel, fields.active, id).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定職務類型。");
  return json({ jobType: await getJobTypeRecord(context.env.DB, id) });
}

/** 已有員工掛在此職務類型時禁止刪除，避免員工主檔失去有效的 job_type_id 參照。 */
async function deleteJobType(context: ApiContext, id: string): Promise<Response> {
  const usage = await context.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM employees WHERE job_type_id = ?",
  ).bind(id).first<{ count: number }>();
  if ((usage?.count ?? 0) > 0) {
    throw new ApiError(409, `此職務類型目前有 ${usage?.count} 位員工使用中，請先變更這些員工的職務類型後再刪除。`);
  }
  const result = await context.env.DB.prepare("DELETE FROM job_types WHERE id = ?").bind(id).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定職務類型。");
  return json({ id, deleted: true });
}

// ---------------------------------------------------------------------------
// 員工個人資料（規格 §三：員工可改個人基本資料）
// ---------------------------------------------------------------------------

interface EmployeeProfileInput {
  name?: unknown;
  email?: unknown;
}

interface EmployeeProfileRecord {
  id: string;
  employeeNo: string;
  name: string;
  email: string;
  department: string;
  grade: string;
  title: string;
  jobTypeId: string;
  jobType: string;
  hireDate: string;
  birthDate: string | null;
  terminationDate: string | null;
  status: "active" | "inactive";
}

/** 刻意不 SELECT salary（規格 §三：薪資為敏感資料，僅 admin 可見，見 /api/admin/employees）。 */
async function getEmployeeProfile(db: D1Database, id: string): Promise<EmployeeProfileRecord> {
  const row = await db.prepare(`
    SELECT e.id, e.employee_no AS employeeNo, e.name, e.email, e.department, e.grade, e.title,
           e.job_type_id AS jobTypeId, jt.name AS jobType, e.hire_date AS hireDate,
           e.birth_date AS birthDate,
           e.termination_date AS terminationDate, e.status
    FROM employees e JOIN job_types jt ON jt.id = e.job_type_id
    WHERE e.id = ?
  `).bind(id).first<EmployeeProfileRecord>();
  if (!row) throw new ApiError(404, "找不到員工資料。");
  return row;
}

async function employeeProfile(
  context: ApiContext,
  user: AuthUser & { employeeId: string },
): Promise<Response> {
  return json({ employee: await getEmployeeProfile(context.env.DB, user.employeeId) });
}

/**
 * 可寫欄位白名單僅 name／email（employees.email 聯絡信箱，與 users.email 登入帳號分離，
 * 改這裡不影響登入身分）。UPDATE 語句寫死只列 name／email 兩欄，不論請求 body 夾帶什麼其他
 * 欄位（department／grade／title／jobTypeId／salary／status／hireDate／terminationDate／
 * employeeNo）都不會被寫入——防護做在 SQL 層，而非「先驗證再擋」的邏輯層。
 */
async function updateEmployeeProfile(
  context: ApiContext,
  user: AuthUser & { employeeId: string },
): Promise<Response> {
  const body = await parseJson<EmployeeProfileInput>(context.request);
  const name = requiredString(body.name, "姓名", 100);
  const email = requiredString(body.email, "Email", 200);
  if (!EMAIL_PATTERN.test(email)) throw new ApiError(422, "Email 格式不正確。");
  await assertEmailAvailable(context.env.DB, email, user.employeeId);
  const result = await context.env.DB.prepare(`
    UPDATE employees SET name = ?, email = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).bind(name, email, user.employeeId).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到員工資料。");
  return json({ employee: await getEmployeeProfile(context.env.DB, user.employeeId) });
}

interface ImportError {
  row: number;
  message: string;
}

interface ImportSummary {
  imported: number;
  updated: number;
  skipped: number;
  errors: ImportError[];
}

/**
 * 員工主檔 CSV 匯入（規格 §九）。以員工編號判斷新建或更新，逐列驗證失敗只記錄錯誤並繼續，
 * 整批回應固定 200。掛在本模組（`src/server/m1.ts`）是因為既有 `/api/admin/employees`
 * GET（見下方 handleAdminM1）已經是本檔在維護，員工主檔目前沒有其他專屬模組。
 */
async function importEmployees(context: ApiContext): Promise<Response> {
  const body = await parseJson<{ csv?: unknown }>(context.request);
  if (typeof body.csv !== "string" || body.csv.trim() === "") {
    throw new ApiError(400, "請提供 csv 欄位（CSV 檔案全文字串）。");
  }
  const table = parseCsvTable(body.csv, EMPLOYEE_CSV_HEADERS);
  const db = context.env.DB;
  const summary: ImportSummary = { imported: 0, updated: 0, skipped: 0, errors: [] };

  for (const row of table.rows) {
    const employeeNo = row.get("員工編號");
    const name = row.get("姓名");
    const email = row.get("Email");
    const department = row.get("部門");
    const grade = row.get("職等");
    const title = row.get("職稱");
    const jobTypeName = row.get("職務類型");
    const hireDate = row.get("到職日");
    const salaryText = row.get("薪資");

    const requiredFields: Array<[string, string]> = [
      ["員工編號", employeeNo],
      ["姓名", name],
      ["Email", email],
      ["部門", department],
      ["職等", grade],
      ["職稱", title],
      ["職務類型", jobTypeName],
      ["到職日", hireDate],
    ];
    const missingField = requiredFields.find(([, value]) => value === "");
    if (missingField) {
      summary.errors.push({ row: row.rowNumber, message: `${missingField[0]}為必填。` });
      summary.skipped += 1;
      continue;
    }
    if (!EMAIL_PATTERN.test(email)) {
      summary.errors.push({ row: row.rowNumber, message: "Email 格式不正確。" });
      summary.skipped += 1;
      continue;
    }
    if (!isValidIsoDate(hireDate)) {
      summary.errors.push({ row: row.rowNumber, message: "到職日格式須為 YYYY-MM-DD。" });
      summary.skipped += 1;
      continue;
    }
    const salary = parseNonNegativeInteger(salaryText, null);
    if (salary === null && salaryText !== "") {
      summary.errors.push({ row: row.rowNumber, message: "薪資須為非負整數。" });
      summary.skipped += 1;
      continue;
    }

    // 生日是選填欄位，刻意不列入 EMPLOYEE_CSV_HEADERS：既有的範本與匯入檔沒有這欄
    // 仍應可用。有這欄且填了值才驗證與寫入。
    const birthDateText = row.get("生日");
    if (birthDateText !== "" && !isValidIsoDate(birthDateText)) {
      summary.errors.push({ row: row.rowNumber, message: "生日格式須為 YYYY-MM-DD。" });
      summary.skipped += 1;
      continue;
    }
    const birthDate = birthDateText === "" ? null : birthDateText;

    const jobType = await db.prepare(
      "SELECT id FROM job_types WHERE name = ?",
    ).bind(jobTypeName).first<{ id: string }>();
    if (!jobType) {
      summary.errors.push({ row: row.rowNumber, message: `找不到職務類型「${jobTypeName}」。` });
      summary.skipped += 1;
      continue;
    }

    const emailConflict = await db.prepare(`
      SELECT employee_no AS employeeNo FROM employees WHERE email = ? COLLATE NOCASE AND employee_no <> ?
    `).bind(email, employeeNo).first<{ employeeNo: string }>();
    if (emailConflict) {
      summary.errors.push({
        row: row.rowNumber,
        message: `Email 已被員工編號「${emailConflict.employeeNo}」使用。`,
      });
      summary.skipped += 1;
      continue;
    }

    const existing = await db.prepare(
      "SELECT id FROM employees WHERE employee_no = ?",
    ).bind(employeeNo).first<{ id: string }>();

    if (existing) {
      await db.prepare(`
        UPDATE employees SET name = ?, email = ?, department = ?, grade = ?, title = ?,
          job_type_id = ?, hire_date = ?, salary = ?,
          -- 未帶生日欄的匯入檔不應把既有生日洗掉，故以 COALESCE 保留原值。
          birth_date = COALESCE(?, birth_date),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).bind(name, email, department, grade, title, jobType.id, hireDate, salary, birthDate, existing.id).run();
      summary.updated += 1;
    } else {
      await db.prepare(`
        INSERT INTO employees (
          id, employee_no, name, email, department, grade, title, job_type_id,
          hire_date, birth_date, salary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        uuid(), employeeNo, name, email, department, grade, title, jobType.id,
        hireDate, birthDate, salary,
      ).run();
      summary.imported += 1;
    }
  }

  return json(summary);
}

async function certificationOptions(context: ApiContext): Promise<Response> {
  const result = await context.env.DB.prepare(`
    SELECT id, name FROM certifications WHERE active = 1 ORDER BY name
  `).all<{ id: string; name: string }>();
  return json({ certifications: result.results });
}

async function employeeSchedule(context: ApiContext, user: AuthUser & { employeeId: string }): Promise<Response> {
  const month = context.url.searchParams.get("month");
  const conditions = [
    "en.employee_id = ?",
    "en.enrollment_status = 'enrolled'",
    "cs.status <> 'cancelled'",
  ];
  const bindings: string[] = [user.employeeId];
  if (month) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new ApiError(422, "month 參數格式須為 YYYY-MM。");
    conditions.push("cs.session_date >= ?", "cs.session_date < date(?, '+1 month')");
    bindings.push(`${month}-01`, `${month}-01`);
  }
  const result = await context.env.DB.prepare(`
    SELECT cs.id, c.id AS courseId, c.name AS courseName,
           c.competency_level AS competencyLevel, c.course_type AS courseType,
           cs.session_date AS sessionDate, cs.start_time AS startTime, cs.end_time AS endTime,
           cs.location, cs.notes, en.source, en.attendance_status AS attendanceStatus
    FROM enrollments en
    JOIN course_sessions cs ON cs.id = en.course_session_id
    JOIN courses c ON c.id = cs.course_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY cs.session_date, cs.start_time
  `).bind(...bindings).all();
  return json({ sessions: result.results });
}

async function openElectives(context: ApiContext, user: AuthUser & { employeeId: string }): Promise<Response> {
  const [result, requiresApproval] = await Promise.all([
    context.env.DB.prepare(`
    SELECT cs.id, c.id AS courseId, c.name AS courseName, c.description,
           c.competency_level AS competencyLevel, c.duration_hours AS durationHours,
           c.instructor, cs.session_date AS sessionDate, cs.start_time AS startTime,
           cs.end_time AS endTime, cs.location, cs.capacity,
           COUNT(CASE WHEN all_en.enrollment_status = 'enrolled' THEN 1 END) AS enrolledCount,
           MAX(CASE WHEN mine.employee_id IS NOT NULL
             AND mine.enrollment_status IN ('enrolled', 'waitlisted') THEN 1 ELSE 0 END) AS alreadyEnrolled,
           MAX(CASE WHEN mine.enrollment_status IN ('enrolled', 'waitlisted')
             THEN mine.enrollment_status ELSE NULL END) AS registrationStatus
    FROM course_sessions cs
    JOIN courses c ON c.id = cs.course_id
    LEFT JOIN enrollments all_en ON all_en.course_session_id = cs.id
    LEFT JOIN enrollments mine ON mine.course_session_id = cs.id AND mine.employee_id = ?
    WHERE c.course_type = 'elective' AND c.enrollment_open = 1 AND c.active = 1
      AND cs.status = 'scheduled' AND cs.session_date >= date('now')
    GROUP BY cs.id ORDER BY cs.session_date, cs.start_time
  `).bind(user.employeeId).all(),
    enrollmentRequiresApproval(context.env.DB),
  ]);
  return json({ sessions: result.results, requiresApproval });
}

async function enrollSelf(context: ApiContext, user: AuthUser & { employeeId: string }, id: string): Promise<Response> {
  const enrollmentId = uuid();
  const requiresApproval = await enrollmentRequiresApproval(context.env.DB);
  const targetStatus = requiresApproval ? "waitlisted" : "enrolled";
  try {
    const result = await context.env.DB.prepare(`
      INSERT INTO enrollments (id, course_session_id, employee_id, source, enrollment_status)
      SELECT ?, cs.id, ?, 'self', ?
      FROM course_sessions cs JOIN courses c ON c.id = cs.course_id
      WHERE cs.id = ? AND cs.status = 'scheduled' AND cs.session_date >= date('now')
        AND c.active = 1 AND c.course_type = 'elective' AND c.enrollment_open = 1
        AND (? = 'waitlisted' OR
          (SELECT COUNT(*) FROM enrollments en
           WHERE en.course_session_id = cs.id AND en.enrollment_status = 'enrolled') < cs.capacity)
        AND NOT EXISTS (
          SELECT 1 FROM enrollments existing
          WHERE existing.course_session_id = cs.id AND existing.employee_id = ?
            AND existing.enrollment_status IN ('enrolled', 'waitlisted')
        )
        AND NOT EXISTS (
          SELECT 1 FROM enrollments en2
          JOIN course_sessions other ON other.id = en2.course_session_id
          WHERE en2.employee_id = ? AND en2.enrollment_status = 'enrolled'
            AND other.status <> 'cancelled' AND other.session_date = cs.session_date
            AND other.start_time < cs.end_time AND other.end_time > cs.start_time
        )
      ON CONFLICT(course_session_id, employee_id) DO UPDATE SET
        source = 'self', enrollment_status = excluded.enrollment_status,
        assigned_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        reviewed_by = NULL, reviewed_at = NULL, review_note = ''
      WHERE enrollments.enrollment_status = 'cancelled'
    `).bind(
      enrollmentId,
      user.employeeId,
      targetStatus,
      id,
      targetStatus,
      user.employeeId,
      user.employeeId,
    ).run();
    if (result.meta.changes === 1) {
      return json({
        enrollmentId,
        status: requiresApproval ? "pending" : "approved",
        enrollmentStatus: targetStatus,
      }, 201);
    }
  } catch {
    // The diagnostic below returns a stable, user-friendly conflict instead of a raw constraint error.
  }

  const session = await context.env.DB.prepare(`
    SELECT cs.id, cs.capacity, cs.status, cs.session_date AS sessionDate,
           c.course_type AS courseType, c.enrollment_open AS enrollmentOpen,
           (SELECT COUNT(*) FROM enrollments en
            WHERE en.course_session_id = cs.id AND en.enrollment_status = 'enrolled') AS enrolledCount,
           (SELECT COUNT(*) FROM enrollments mine
            WHERE mine.course_session_id = cs.id AND mine.employee_id = ?
              AND mine.enrollment_status IN ('enrolled', 'waitlisted')) AS mine
    FROM course_sessions cs JOIN courses c ON c.id = cs.course_id WHERE cs.id = ?
  `).bind(user.employeeId, id).first<{
    id: string;
    capacity: number;
    status: string;
    sessionDate: string;
    courseType: string;
    enrollmentOpen: number;
    enrolledCount: number;
    mine: number;
  }>();
  if (!session) throw new ApiError(404, "找不到指定場次。");
  if (session.mine > 0) throw new ApiError(409, "您已報名或正在等候審核。");
  if (!requiresApproval && session.enrolledCount >= session.capacity) {
    throw new ApiError(409, "此場次名額已滿。");
  }
  if (session.courseType !== "elective" || session.enrollmentOpen !== 1) {
    throw new ApiError(403, "此課程未開放員工自行報名。");
  }
  throw new ApiError(409, "此場次與您既有課表衝突，無法報名。");
}

async function cancelSelfEnrollment(
  context: ApiContext,
  user: AuthUser & { employeeId: string },
  id: string,
): Promise<Response> {
  const result = await context.env.DB.prepare(`
    UPDATE enrollments SET enrollment_status = 'cancelled'
    WHERE course_session_id = ? AND employee_id = ? AND source = 'self'
      AND attendance_status = 'pending' AND enrollment_status IN ('enrolled', 'waitlisted')
  `).bind(id, user.employeeId).run();
  if (result.meta.changes === 0) throw new ApiError(409, "此報名無法取消或不存在。");
  return json({ cancelled: true });
}

async function employeeTrainingRecords(
  context: ApiContext,
  user: AuthUser & { employeeId: string },
): Promise<Response> {
  const [records, completion] = await Promise.all([
    context.env.DB.prepare(`
      SELECT tr.id, c.name AS courseName, c.competency_level AS competencyLevel,
             tr.completed_at AS completedAt, tr.hours, tr.valid_until AS validUntil,
             cs.session_date AS sessionDate
      FROM training_records tr
      JOIN courses c ON c.id = tr.course_id
      JOIN course_sessions cs ON cs.id = tr.course_session_id
      WHERE tr.employee_id = ? ORDER BY tr.completed_at DESC
    `).bind(user.employeeId).all(),
    completionData(context.env.DB, { employeeId: user.employeeId }),
  ]);
  return json({ records: records.results, completion: completion[0] ?? null });
}

export async function handleAdminM1(context: ApiContext, path: string): Promise<Response | null> {
  const admin = context.user;
  if (!admin) throw new ApiError(401, "請先登入。");

  if (path === "/api/admin/employees" && context.request.method === "GET") return listEmployees(context);
  if (path === "/api/admin/employees" && context.request.method === "POST") return createEmployee(context);
  if (path === "/api/admin/employees/import" && context.request.method === "POST") {
    return importEmployees(context);
  }
  const employeeMatch = path.match(/^\/api\/admin\/employees\/([^/]+)$/);
  if (employeeMatch?.[1] && context.request.method === "PATCH") return updateEmployee(context, employeeMatch[1]);

  if (path === "/api/admin/job-types" && context.request.method === "GET") return listJobTypes(context);
  if (path === "/api/admin/job-types" && context.request.method === "POST") return createJobType(context);
  const jobTypeMatch = path.match(/^\/api\/admin\/job-types\/([^/]+)$/);
  if (jobTypeMatch?.[1] && context.request.method === "PATCH") return updateJobType(context, jobTypeMatch[1]);
  if (jobTypeMatch?.[1] && context.request.method === "DELETE") return deleteJobType(context, jobTypeMatch[1]);

  if (path === "/api/admin/certifications/options" && context.request.method === "GET") {
    return certificationOptions(context);
  }
  if (path === "/api/admin/courses" && context.request.method === "GET") return listCourses(context);
  if (path === "/api/admin/courses" && context.request.method === "POST") return createCourse(context);
  const courseMatch = path.match(/^\/api\/admin\/courses\/([^/]+)$/);
  if (courseMatch?.[1] && context.request.method === "PATCH") return updateCourse(context, courseMatch[1]);
  if (courseMatch?.[1] && context.request.method === "DELETE") return archiveCourse(context, courseMatch[1]);

  if (path === "/api/admin/special-days" && context.request.method === "GET") return listSpecialDays(context);
  if (path === "/api/admin/special-days" && context.request.method === "POST") {
    return createSpecialDay(context, admin);
  }
  const dayMatch = path.match(/^\/api\/admin\/special-days\/([^/]+)$/);
  if (dayMatch?.[1] && context.request.method === "PATCH") return updateSpecialDay(context, dayMatch[1]);
  if (dayMatch?.[1] && context.request.method === "DELETE") return deleteSpecialDay(context, dayMatch[1]);

  if (path === "/api/admin/calendar" && context.request.method === "GET") return listCalendar(context);
  if (path === "/api/admin/course-sessions" && context.request.method === "GET") return listSessions(context);
  if (path === "/api/admin/course-sessions/assignment-preview" && context.request.method === "POST") {
    const body = await parseJson<SessionInput>(context.request);
    return json(await assignmentPreview(context.env.DB, body));
  }
  if (path === "/api/admin/course-sessions" && context.request.method === "POST") {
    return createSession(context, admin);
  }
  const attendanceMatch = path.match(/^\/api\/admin\/course-sessions\/([^/]+)\/attendance$/);
  if (attendanceMatch?.[1] && context.request.method === "GET") return getAttendance(context, attendanceMatch[1]);
  if (attendanceMatch?.[1] && context.request.method === "PUT") return recordAttendance(context, attendanceMatch[1]);
  const sessionMatch = path.match(/^\/api\/admin\/course-sessions\/([^/]+)$/);
  if (sessionMatch?.[1] && context.request.method === "PATCH") {
    return updateSession(context, admin, sessionMatch[1]);
  }
  if (sessionMatch?.[1] && context.request.method === "DELETE") return cancelSession(context, sessionMatch[1]);

  if (path === "/api/admin/completion" && context.request.method === "GET") {
    return completionTracking(context);
  }
  return null;
}

export async function handleEmployeeM1(context: ApiContext, path: string): Promise<Response | null> {
  const user = requireEmployeeIdentity(context.user);
  if (path === "/api/employee/schedule" && context.request.method === "GET") {
    return employeeSchedule(context, user);
  }
  if (path === "/api/employee/courses/open" && context.request.method === "GET") {
    return openElectives(context, user);
  }
  const enrollmentMatch = path.match(/^\/api\/employee\/course-sessions\/([^/]+)\/enroll$/);
  if (enrollmentMatch?.[1] && context.request.method === "POST") {
    return enrollSelf(context, user, enrollmentMatch[1]);
  }
  if (enrollmentMatch?.[1] && context.request.method === "DELETE") {
    return cancelSelfEnrollment(context, user, enrollmentMatch[1]);
  }
  if (path === "/api/employee/training-records" && context.request.method === "GET") {
    return employeeTrainingRecords(context, user);
  }
  if (path === "/api/employee/profile" && context.request.method === "GET") {
    return employeeProfile(context, user);
  }
  if (path === "/api/employee/profile" && context.request.method === "PATCH") {
    return updateEmployeeProfile(context, user);
  }
  return null;
}
