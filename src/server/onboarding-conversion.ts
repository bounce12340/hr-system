import { ApiError, json, parseJson, requiredString, uuid } from "./http";
import type { ApiContext, AuthUser } from "./types";

/** Real calendar date only. Date.parse accepts overflow such as 2026-02-30. */
export function strictIsoDate(value: unknown, label: string): string {
  const text = requiredString(value, label, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new ApiError(422, `${label}格式須為 YYYY-MM-DD。`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new ApiError(422, `${label}不是有效的日曆日期。`);
  }
  return text;
}

interface ConversionBody {
  employeeNo?: unknown; email?: unknown; department?: unknown; grade?: unknown;
  title?: unknown; jobTypeId?: unknown; hireDate?: unknown; salary?: unknown;
  confirmed?: unknown;
}

interface ExistingConversion {
  employeeId: string;
  employeeNo: string;
  email: string;
  department: string;
  grade: string;
  title: string;
  jobTypeId: string;
  hireDate: string;
  salary: number | null;
}

function sameConversion(existing: ExistingConversion, input: {
  employeeNo: string; email: string; department: string; grade: string; title: string;
  jobTypeId: string; hireDate: string; salary: number | null;
}): boolean {
  return existing.employeeNo === input.employeeNo
    && existing.email.toLowerCase() === input.email.toLowerCase()
    && existing.department === input.department
    && existing.grade === input.grade
    && existing.title === input.title
    && existing.jobTypeId === input.jobTypeId
    && existing.hireDate === input.hireDate
    && existing.salary === input.salary;
}

async function existingConversion(db: D1Database, applicationId: string): Promise<ExistingConversion | null> {
  return db.prepare(`
    SELECT c.employee_id AS employeeId, e.employee_no AS employeeNo, e.email,
           e.department, e.grade, e.title, e.job_type_id AS jobTypeId,
           e.hire_date AS hireDate, e.salary
    FROM recruitment_employee_conversions c
    JOIN employees e ON e.id = c.employee_id
    WHERE c.application_id = ?
  `).bind(applicationId).first<ExistingConversion>();
}

async function conversionWasLegacyBackfill(db: D1Database, applicationId: string): Promise<boolean> {
  const audit = await db.prepare(`
    SELECT details FROM audit_logs
    WHERE action = 'onboarding.convert' AND entity_type = 'candidate_application' AND entity_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).bind(applicationId).first<{ details: string }>();
  return audit?.details.includes('"legacyBackfill":true') ?? false;
}

/**
 * Explicit HR conversion only. It never creates a users row or links one by email.
 * The INSERT predicate repeats all mutable eligibility checks so the D1 batch stays
 * conditional if another administrator changes the application concurrently.
 */
export async function convertHiredApplication(context: ApiContext, admin: AuthUser, applicationId: string): Promise<Response> {
  const body = await parseJson<ConversionBody>(context.request);
  if (body.confirmed !== true) throw new ApiError(422, "請明確確認到職資料後再送出。");
  const employeeNo = requiredString(body.employeeNo, "員工編號", 100);
  const email = requiredString(body.email, "員工Email", 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(422, "員工Email格式不正確。");
  const department = requiredString(body.department, "部門", 200);
  const grade = requiredString(body.grade, "職等", 100);
  const title = requiredString(body.title, "職務", 200);
  const jobTypeId = requiredString(body.jobTypeId, "職務類型", 100);
  const hireDate = strictIsoDate(body.hireDate, "到職日");
  const salary = body.salary === null || body.salary === "" ? null : body.salary;
  if (salary !== null && (typeof salary !== "number" || !Number.isInteger(salary) || salary < 0 || salary > 100000000)) throw new ApiError(422, "薪資須為非負整數；不確定時請由 HR 確認。");
  const input = { employeeNo, email, department, grade, title, jobTypeId, hireDate, salary };
  const db = context.env.DB;

  // An exact retry is safe and does not write a second employee/history/audit row.
  // A different retry is refused rather than silently accepting conflicting HR data.
  const before = await existingConversion(db, applicationId);
  if (before) {
    if (!sameConversion(before, input)) throw new ApiError(409, "此應徵已轉為員工，重送資料與既有員工主檔不一致。");
    return json({
      applicationId, employeeId: before.employeeId, status: "onboarded", alreadyConverted: true,
      legacyBackfill: await conversionWasLegacyBackfill(db, applicationId),
    });
  }

  const employeeId = uuid();
  const historyId = uuid();
  const auditId = uuid();
  // historyId is unique and this request inserts that row only for a hired conversion,
  // so the audit flag is the batch's own history row, not a status read before batch.
  const legacyAudit = '{"employeeCreated":true,"legacyBackfill":true}';
  const standardAudit = '{"employeeCreated":true}';
  const results = await db.batch([
    db.prepare(`INSERT INTO employees (id,employee_no,name,email,department,grade,title,job_type_id,hire_date,status,salary)
      SELECT ?, ?, c.name, ?, ?, ?, ?, ?, ?, 'active', ?
      FROM candidates c
      JOIN candidate_applications ca ON ca.candidate_id = c.id
      WHERE ca.id = ? AND ca.status IN ('hired', 'onboarded')
        AND (c.email IS NULL OR lower(c.email) = lower(?))
        AND EXISTS (SELECT 1 FROM job_types jt WHERE jt.id = ? AND jt.active = 1)
        AND NOT EXISTS (
          SELECT 1 FROM onboarding_items oi
          LEFT JOIN application_onboarding_checklist aoc
            ON aoc.application_id = ca.id AND aoc.onboarding_item_id = oi.id
          WHERE oi.active = 1 AND oi.required = 1 AND COALESCE(aoc.completed, 0) = 0
        )
        AND NOT EXISTS (SELECT 1 FROM recruitment_employee_conversions x WHERE x.application_id = ca.id)
        AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.employee_no = ? OR lower(e.email) = lower(?))`)
      .bind(employeeId, employeeNo, email, department, grade, title, jobTypeId, hireDate, salary,
        applicationId, email, jobTypeId, employeeNo, email),
    db.prepare(`INSERT INTO recruitment_employee_conversions(application_id,employee_id,created_by)
      SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM employees WHERE id = ?)`)
      .bind(applicationId, employeeId, admin.id, employeeId),
    db.prepare(`INSERT INTO candidate_application_status_history(id,application_id,from_status,to_status,changed_by,note)
      SELECT ?, id, 'hired', 'onboarded', ?, 'HR確認到職並建立員工主檔'
      FROM candidate_applications
      WHERE id = ? AND status = 'hired'
        AND EXISTS (SELECT 1 FROM recruitment_employee_conversions WHERE application_id = ? AND employee_id = ?)`)
      .bind(historyId, admin.id, applicationId, applicationId, employeeId),
    db.prepare(`UPDATE candidate_applications
      SET status = 'onboarded', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND status = 'hired'
        AND EXISTS (SELECT 1 FROM recruitment_employee_conversions WHERE application_id = ? AND employee_id = ?)`)
      .bind(applicationId, applicationId, employeeId),
    db.prepare(`INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id,details)
      SELECT ?, ?, 'onboarding.convert', 'candidate_application', ?,
        CASE WHEN EXISTS (SELECT 1 FROM candidate_application_status_history WHERE id = ?)
          THEN ? ELSE ? END
      WHERE EXISTS (SELECT 1 FROM recruitment_employee_conversions WHERE application_id = ? AND employee_id = ?)`)
      .bind(auditId, admin.id, applicationId, historyId, standardAudit, legacyAudit, applicationId, employeeId),
  ]);
  if (results[0]?.meta.changes === 1) {
    return json({
      applicationId, employeeId, status: "onboarded", alreadyConverted: false,
      legacyBackfill: results[2]?.meta.changes === 0,
    }, 201);
  }

  // A competing successful batch is an idempotent retry; other predicate failures
  // deliberately remain a conflict and do not reveal another employee's details.
  const after = await existingConversion(db, applicationId);
  if (after && sameConversion(after, input)) {
    return json({
      applicationId, employeeId: after.employeeId, status: "onboarded", alreadyConverted: true,
      legacyBackfill: await conversionWasLegacyBackfill(db, applicationId),
    });
  }
  if (after) throw new ApiError(409, "此應徵已由其他管理員轉為員工；請重新整理核對。");
  throw new ApiError(409, "僅能轉換已錄取或既有到職且已完成必填到職文件、尚未建立員工的應徵；員編與Email須未使用，職務類型須啟用。");
}
