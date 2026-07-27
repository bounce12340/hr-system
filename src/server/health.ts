/**
 * 員工健康檢查追蹤（人資新增需求，原規格未涵蓋）。
 *
 * 一、健檢頻率不由使用者輸入，一律依台灣《勞工健康保護規則》的年齡分級**即時計算**：
 *       未滿 40 歲        → 每 5 年（60 個月）
 *       40 歲以上未滿 65  → 每 3 年（36 個月）
 *       65 歲以上         → 每 1 年（12 個月）
 *     年齡以「今日」計算足歲，下次應檢日 = 最後一次健檢日 + 目前年齡對應的間隔。
 *     刻意不把 next_due_date 存進資料庫：員工一過生日級距就會改變，存欄位就得跑排程回填。
 *     全部 on-read 計算，與 m2 的證照提醒（m2.ts:198）／m3 的試用期提醒（m3.ts:1112）一致。
 *
 * 二、健檢紀錄屬個資法第 6 條特種個資：
 *     admin 端點統一由 router.ts:62 的 requireAdmin 擋下（員工打 admin 端點得 403）；
 *     員工端點的資料範圍以 SQL 的 `WHERE employee_id = ?` 直接綁定登入者，
 *     不做「先查全部再過濾」（同 m5.ts:627 的 employeeIdp）。
 */

import {
  ApiError,
  json,
  optionalString,
  parseJson,
  requireAdmin,
  requireEmployeeIdentity,
  requiredString,
  uuid,
} from "./http";
import type { ApiContext, AuthUser } from "./types";

/** 《勞工健康保護規則》年齡分級 → 健檢間隔（月）。順序有意義：由小到大取第一個符合者。 */
const AGE_INTERVALS = [
  { maxAgeExclusive: 40, intervalMonths: 60 },
  { maxAgeExclusive: 65, intervalMonths: 36 },
] as const;
const OLDEST_INTERVAL_MONTHS = 12;

/**
 * `missing_birth_date` 是規格四種狀態之外額外定義的第五種。
 * 沒有生日就算不出年齡級距，也就算不出間隔與應檢日——這種列一律標成需補資料，
 * **不套用任何預設間隔**，避免把「不知道」靜默變成「每 5 年」而漏掉高齡員工。
 */
export const HEALTH_CHECK_STATUSES = [
  "overdue",
  "due_soon",
  "ok",
  "never",
  "missing_birth_date",
] as const;

export type HealthCheckStatus = (typeof HEALTH_CHECK_STATUSES)[number];

const STATUS_LABELS: Record<HealthCheckStatus, string> = {
  overdue: "已逾期",
  due_soon: "即將到期",
  ok: "尚未到期",
  never: "從未健檢",
  missing_birth_date: "缺生日資料",
};

const RESULT_VALUES = ["normal", "abnormal", "follow_up", "pending"] as const;
type ResultValue = (typeof RESULT_VALUES)[number];

const RESULT_LABELS: Record<ResultValue, string> = {
  normal: "正常",
  abnormal: "異常",
  follow_up: "需複檢",
  pending: "待判讀",
};

const DEFAULT_REMINDER_MONTHS = 2;
const MIN_REMINDER_MONTHS = 1;
const MAX_REMINDER_MONTHS = 3;
/** `?months=` 上限：50 年。足以讓管理者一次看到所有人，又不至於讓數字失去意義。 */
const MAX_WINDOW_MONTHS = 600;

interface HealthCheckItemInput {
  name?: unknown;
  category?: unknown;
  required?: unknown;
  active?: unknown;
  sortOrder?: unknown;
}

interface HealthCheckResultInput {
  itemId?: unknown;
  result?: unknown;
  notes?: unknown;
}

interface HealthCheckInput {
  employeeId?: unknown;
  checkDate?: unknown;
  institution?: unknown;
  notes?: unknown;
  items?: unknown;
}

interface DueRow {
  employeeId: string;
  employeeNo: string;
  name: string;
  department: string;
  birthDate: string | null;
  hireDate: string;
  lastCheckDate: string | null;
  age: number | null;
  intervalMonths: number | null;
  nextDueDate: string | null;
  monthsUntilDue: number | null;
}

export interface DueEmployee extends DueRow {
  status: HealthCheckStatus;
  statusLabel: string;
  /** 從未健檢者的應檢日以到職日為基準推算，這裡標明基準來源，避免前端誤解 nextDueDate。 */
  dueBasis: "last_check" | "hire_date" | "unknown";
}

interface HealthCheckRow {
  id: string;
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  department: string;
  checkDate: string;
  institution: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

interface HealthCheckResultRow {
  id: string;
  healthCheckId: string;
  itemId: string;
  itemName: string;
  category: string;
  itemActive: number;
  result: ResultValue;
  notes: string;
}

interface HealthCheckResultItem {
  id: string;
  itemId: string;
  itemName: string;
  category: string;
  itemActive: number;
  result: ResultValue;
  resultLabel: string;
  notes: string;
}

// ---------------------------------------------------------------------------
// 驗證輔助
// ---------------------------------------------------------------------------

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ApiError(422, `${label}須為 ${min}～${max} 的整數。`);
  }
  return value;
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

function resultValue(value: unknown): ResultValue {
  if (value === undefined || value === null || value === "") return "pending";
  if (RESULT_VALUES.includes(value as ResultValue)) return value as ResultValue;
  throw new ApiError(422, "檢查結果須為正常、異常、需複檢或待判讀。");
}

/**
 * 提醒月數限制 1～3（migration 0011 的設定說明亦如此標示）。
 * 讀取時再夾一次上下限，是為了防止有人繞過 API 直接改資料庫後讓提醒視窗失控。
 */
export async function healthCheckReminderMonths(db: D1Database): Promise<number> {
  const row = await db.prepare(`
    SELECT setting_value AS value FROM settings WHERE setting_key = 'health_check_reminder_months'
  `).first<{ value: string }>();
  const value = Number(row?.value ?? String(DEFAULT_REMINDER_MONTHS));
  return Number.isInteger(value) && value >= MIN_REMINDER_MONTHS && value <= MAX_REMINDER_MONTHS
    ? value
    : DEFAULT_REMINDER_MONTHS;
}

// ---------------------------------------------------------------------------
// 待健檢計算
// ---------------------------------------------------------------------------

/**
 * 年齡、間隔、應檢日、剩餘月數全部在 SQL 內算完，排序與 `?months=` 篩選才能交給資料庫，
 * 不必把全公司的人撈進記憶體再排。
 *
 * - 足歲：年份差再扣掉「今年生日還沒到」的那一歲（`'%m-%d'` 字串比較即可，不需日期運算）。
 * - 應檢日基準：有健檢紀錄取最後一次；從未健檢者取到職日，據此算出「已延遲多久」。
 * - monthsUntilDue：整月數（不足一個月無條件捨去），已逾期為負數。
 *
 * `employeeScoped = true` 時改為單一員工，且**不**限定在職狀態
 * （離職者仍可能登入查自己的歷史紀錄，不應因為 status 就查不到自己的資料）。
 */
function dueQuery(employeeScoped: boolean): string {
  const scope = employeeScoped ? "e.id = ?" : "e.status = 'active'";
  return `
    WITH latest AS (
      SELECT employee_id AS employeeId, MAX(check_date) AS lastCheckDate
      FROM health_checks
      GROUP BY employee_id
    ),
    profile AS (
      SELECT e.id AS employeeId, e.employee_no AS employeeNo, e.name AS name,
             e.department AS department, e.birth_date AS birthDate, e.hire_date AS hireDate,
             l.lastCheckDate AS lastCheckDate,
             CASE WHEN e.birth_date IS NULL THEN NULL ELSE
               CAST(strftime('%Y', 'now') AS INTEGER) - CAST(strftime('%Y', e.birth_date) AS INTEGER)
               - (CASE WHEN strftime('%m-%d', 'now') < strftime('%m-%d', e.birth_date) THEN 1 ELSE 0 END)
             END AS age
      FROM employees e
      LEFT JOIN latest l ON l.employeeId = e.id
      WHERE ${scope}
    ),
    graded AS (
      SELECT p.employeeId, p.employeeNo, p.name, p.department, p.birthDate, p.hireDate,
             p.lastCheckDate, p.age,
             CASE WHEN p.age IS NULL THEN NULL
                  WHEN p.age < ${AGE_INTERVALS[0].maxAgeExclusive} THEN ${AGE_INTERVALS[0].intervalMonths}
                  WHEN p.age < ${AGE_INTERVALS[1].maxAgeExclusive} THEN ${AGE_INTERVALS[1].intervalMonths}
                  ELSE ${OLDEST_INTERVAL_MONTHS} END AS intervalMonths
      FROM profile p
    ),
    scheduled AS (
      SELECT g.employeeId, g.employeeNo, g.name, g.department, g.birthDate, g.hireDate,
             g.lastCheckDate, g.age, g.intervalMonths,
             CASE WHEN g.intervalMonths IS NULL THEN NULL
                  ELSE date(COALESCE(g.lastCheckDate, g.hireDate), '+' || g.intervalMonths || ' month')
             END AS nextDueDate
      FROM graded g
    ),
    scored AS (
      SELECT s.employeeId, s.employeeNo, s.name, s.department, s.birthDate, s.hireDate,
             s.lastCheckDate, s.age, s.intervalMonths, s.nextDueDate,
             CASE WHEN s.nextDueDate IS NULL THEN NULL ELSE
               (CAST(strftime('%Y', s.nextDueDate) AS INTEGER) - CAST(strftime('%Y', 'now') AS INTEGER)) * 12
               + (CAST(strftime('%m', s.nextDueDate) AS INTEGER) - CAST(strftime('%m', 'now') AS INTEGER))
               - (CASE WHEN CAST(strftime('%d', s.nextDueDate) AS INTEGER)
                            < CAST(strftime('%d', 'now') AS INTEGER) THEN 1 ELSE 0 END)
             END AS monthsUntilDue
      FROM scheduled s
    )
    SELECT employeeId, employeeNo, name, department, birthDate, hireDate,
           lastCheckDate, age, intervalMonths, nextDueDate, monthsUntilDue
    FROM scored
  `;
}

function classify(row: DueRow, reminderMonths: number): HealthCheckStatus {
  if (row.birthDate === null || row.intervalMonths === null || row.monthsUntilDue === null) {
    return "missing_birth_date";
  }
  if (row.lastCheckDate === null) return "never";
  if (row.monthsUntilDue < 0) return "overdue";
  if (row.monthsUntilDue <= reminderMonths) return "due_soon";
  return "ok";
}

function decorate(row: DueRow, reminderMonths: number): DueEmployee {
  const status = classify(row, reminderMonths);
  return {
    ...row,
    status,
    statusLabel: STATUS_LABELS[status],
    dueBasis: status === "missing_birth_date"
      ? "unknown"
      : row.lastCheckDate === null ? "hire_date" : "last_check",
  };
}

/**
 * 待健檢名單。
 *
 * 篩選：`monthsUntilDue <= windowMonths`（含已逾期的負數）。缺生日者算不出 monthsUntilDue，
 * 一律保留在名單內——這是需要人資補資料的例外，不能因為算不出來就從名單上消失。
 *
 * 排序：以「最急迫者在前」為準，直接用 monthsUntilDue 由小到大。逾期越久越前面，
 * 接著是即將到期、尚未到期；從未健檢者以到職日推算的急迫度自然穿插其中。
 * 算不出來的（缺生日）排在最後，再依員工編號。
 */
export async function dueEmployees(
  db: D1Database,
  options: { windowMonths?: number } = {},
): Promise<{ reminderMonths: number; windowMonths: number; employees: DueEmployee[] }> {
  const reminderMonths = await healthCheckReminderMonths(db);
  const windowMonths = options.windowMonths ?? reminderMonths;
  const result = await db.prepare(`
    ${dueQuery(false)}
    WHERE monthsUntilDue IS NULL OR monthsUntilDue <= ?
    ORDER BY CASE WHEN monthsUntilDue IS NULL THEN 1 ELSE 0 END,
             monthsUntilDue,
             nextDueDate,
             employeeNo
  `).bind(windowMonths).all<DueRow>();
  return {
    reminderMonths,
    windowMonths,
    employees: result.results.map((row) => decorate(row, reminderMonths)),
  };
}

/** admin 儀表板提醒中心用：只取預設提醒視窗（settings）內的名單。 */
export async function healthCheckReminders(db: D1Database): Promise<DueEmployee[]> {
  return (await dueEmployees(db)).employees;
}

async function listDue(context: ApiContext): Promise<Response> {
  const raw = context.url.searchParams.get("months");
  let windowMonths: number | undefined;
  if (raw !== null && raw.trim() !== "") {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_WINDOW_MONTHS) {
      throw new ApiError(422, `months 須為 1～${MAX_WINDOW_MONTHS} 的整數。`);
    }
    windowMonths = parsed;
  }
  const result = await dueEmployees(context.env.DB, windowMonths === undefined ? {} : { windowMonths });
  return json(result);
}

// ---------------------------------------------------------------------------
// 健檢項目主檔
// ---------------------------------------------------------------------------

async function listItems(context: ApiContext): Promise<Response> {
  const result = await context.env.DB.prepare(`
    SELECT id, name, category, required, active, sort_order AS sortOrder
    FROM health_check_items
    ORDER BY active DESC, sort_order, name
  `).all();
  return json({ items: result.results });
}

function parseItem(body: HealthCheckItemInput) {
  return {
    name: requiredString(body.name, "健檢項目名稱", 200),
    category: optionalString(body.category, "健檢項目分類", 100),
    required: booleanValue(body.required, "是否必檢", true) ? 1 : 0,
    active: booleanValue(body.active, "是否啟用", true) ? 1 : 0,
    sortOrder: body.sortOrder === undefined || body.sortOrder === null
      ? 0
      : integer(body.sortOrder, "排序", 0, 9999),
  };
}

async function createItem(context: ApiContext): Promise<Response> {
  const item = parseItem(await parseJson<HealthCheckItemInput>(context.request));
  const id = uuid();
  try {
    await context.env.DB.prepare(`
      INSERT INTO health_check_items (id, name, category, required, active, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(id, item.name, item.category, item.required, item.active, item.sortOrder).run();
  } catch {
    throw new ApiError(409, "健檢項目名稱不可重複。");
  }
  return json({ id, ...item }, 201);
}

async function updateItem(context: ApiContext, id: string): Promise<Response> {
  const item = parseItem(await parseJson<HealthCheckItemInput>(context.request));
  try {
    const result = await context.env.DB.prepare(`
      UPDATE health_check_items
      SET name = ?, category = ?, required = ?, active = ?, sort_order = ?
      WHERE id = ?
    `).bind(item.name, item.category, item.required, item.active, item.sortOrder, id).run();
    if (result.meta.changes === 0) throw new ApiError(404, "找不到指定健檢項目。");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(409, "健檢項目名稱不可重複。");
  }
  return json({ id, ...item });
}

/**
 * 尚未被任何健檢紀錄引用 → 直接刪列；已被引用 → 改為停用（active = 0）。
 * 硬刪會扯斷既有健檢紀錄的項目名稱，而健檢紀錄是特種個資，缺欄位比留著更糟。
 * 回應以 deleted／archived 兩個布林明白區分，前端不必猜。
 */
async function deleteItem(context: ApiContext, id: string): Promise<Response> {
  const existing = await context.env.DB.prepare(
    "SELECT id FROM health_check_items WHERE id = ?",
  ).bind(id).first<{ id: string }>();
  if (!existing) throw new ApiError(404, "找不到指定健檢項目。");

  const used = await context.env.DB.prepare(
    "SELECT 1 AS used FROM health_check_results WHERE health_check_item_id = ? LIMIT 1",
  ).bind(id).first<{ used: number }>();
  if (used) {
    await context.env.DB.prepare(
      "UPDATE health_check_items SET active = 0 WHERE id = ?",
    ).bind(id).run();
    return json({ id, deleted: false, archived: true, message: "此項目已有健檢紀錄使用，已改為停用。" });
  }
  await context.env.DB.prepare("DELETE FROM health_check_items WHERE id = ?").bind(id).run();
  return json({ id, deleted: true, archived: false });
}

// ---------------------------------------------------------------------------
// 健檢紀錄
// ---------------------------------------------------------------------------

async function attachResults<T extends { id: string }>(
  db: D1Database,
  checks: T[],
): Promise<Array<T & { items: HealthCheckResultItem[] }>> {
  if (checks.length === 0) return [];
  const placeholders = checks.map(() => "?").join(", ");
  const result = await db.prepare(`
    SELECT r.id, r.health_check_id AS healthCheckId, r.health_check_item_id AS itemId,
           i.name AS itemName, i.category, i.active AS itemActive, r.result, r.notes
    FROM health_check_results r
    JOIN health_check_items i ON i.id = r.health_check_item_id
    WHERE r.health_check_id IN (${placeholders})
    ORDER BY i.sort_order, i.name
  `).bind(...checks.map((check) => check.id)).all<HealthCheckResultRow>();

  const byCheck = new Map<string, HealthCheckResultItem[]>();
  for (const { healthCheckId, ...rest } of result.results) {
    byCheck.set(healthCheckId, [
      ...(byCheck.get(healthCheckId) ?? []),
      { ...rest, resultLabel: RESULT_LABELS[rest.result] },
    ]);
  }
  return checks.map((check) => ({ ...check, items: byCheck.get(check.id) ?? [] }));
}

async function listChecks(context: ApiContext): Promise<Response> {
  const employeeId = context.url.searchParams.get("employeeId");
  const filter = employeeId ? "WHERE hc.employee_id = ?" : "";
  const statement = context.env.DB.prepare(`
    SELECT hc.id, hc.employee_id AS employeeId, e.employee_no AS employeeNo,
           e.name AS employeeName, e.department,
           hc.check_date AS checkDate, hc.institution, hc.notes,
           hc.created_at AS createdAt, hc.updated_at AS updatedAt
    FROM health_checks hc
    JOIN employees e ON e.id = hc.employee_id
    ${filter}
    ORDER BY date(hc.check_date) DESC, e.employee_no
  `);
  const result = employeeId
    ? await statement.bind(employeeId).all<HealthCheckRow>()
    : await statement.all<HealthCheckRow>();
  return json({ healthChecks: await attachResults(context.env.DB, result.results) });
}

function parseCheck(body: HealthCheckInput) {
  const checkDate = isoDate(body.checkDate, "健檢日期");
  if (checkDate > new Date().toISOString().slice(0, 10)) {
    throw new ApiError(422, "健檢日期不可晚於今天。");
  }
  return {
    employeeId: requiredString(body.employeeId, "員工", 100),
    checkDate,
    institution: optionalString(body.institution, "檢查機構", 200),
    notes: optionalString(body.notes, "健檢備註", 5000),
  };
}

function parseResultItems(body: HealthCheckInput): Array<{ itemId: string; result: ResultValue; notes: string }> {
  if (body.items === undefined || body.items === null) return [];
  if (!Array.isArray(body.items)) throw new ApiError(422, "健檢項目須為陣列。");
  const seen = new Set<string>();
  return body.items.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ApiError(422, `第 ${index + 1} 個健檢項目格式不正確。`);
    }
    const record = raw as HealthCheckResultInput;
    const itemId = requiredString(record.itemId, `第 ${index + 1} 個健檢項目`, 100);
    if (seen.has(itemId)) throw new ApiError(422, "同一次健檢不可重複勾選相同項目。");
    seen.add(itemId);
    return {
      itemId,
      result: resultValue(record.result),
      notes: optionalString(record.notes, "項目備註", 2000),
    };
  });
}

async function assertEmployeeExists(db: D1Database, employeeId: string): Promise<void> {
  const employee = await db.prepare("SELECT id FROM employees WHERE id = ?")
    .bind(employeeId).first<{ id: string }>();
  if (!employee) throw new ApiError(404, "找不到指定員工。");
}

async function assertItemsExist(
  db: D1Database,
  items: Array<{ itemId: string }>,
): Promise<void> {
  if (items.length === 0) return;
  const placeholders = items.map(() => "?").join(", ");
  const found = await db.prepare(
    `SELECT id FROM health_check_items WHERE id IN (${placeholders})`,
  ).bind(...items.map((item) => item.itemId)).all<{ id: string }>();
  const known = new Set(found.results.map((row) => row.id));
  const missing = items.find((item) => !known.has(item.itemId));
  if (missing) throw new ApiError(404, "找不到指定健檢項目。");
}

function resultStatements(
  db: D1Database,
  checkId: string,
  items: Array<{ itemId: string; result: ResultValue; notes: string }>,
): D1PreparedStatement[] {
  return items.map((item) => db.prepare(`
    INSERT INTO health_check_results (id, health_check_id, health_check_item_id, result, notes)
    VALUES (?, ?, ?, ?, ?)
  `).bind(uuid(), checkId, item.itemId, item.result, item.notes));
}

async function readCheck(db: D1Database, id: string): Promise<unknown> {
  const row = await db.prepare(`
    SELECT hc.id, hc.employee_id AS employeeId, e.employee_no AS employeeNo,
           e.name AS employeeName, e.department,
           hc.check_date AS checkDate, hc.institution, hc.notes,
           hc.created_at AS createdAt, hc.updated_at AS updatedAt
    FROM health_checks hc
    JOIN employees e ON e.id = hc.employee_id
    WHERE hc.id = ?
  `).bind(id).first<HealthCheckRow>();
  if (!row) throw new ApiError(404, "找不到指定健檢紀錄。");
  return (await attachResults(db, [row]))[0];
}

async function createCheck(context: ApiContext): Promise<Response> {
  const body = await parseJson<HealthCheckInput>(context.request);
  const check = parseCheck(body);
  const items = parseResultItems(body);
  await assertEmployeeExists(context.env.DB, check.employeeId);
  await assertItemsExist(context.env.DB, items);

  const id = uuid();
  try {
    await context.env.DB.batch([
      context.env.DB.prepare(`
        INSERT INTO health_checks (id, employee_id, check_date, institution, notes)
        VALUES (?, ?, ?, ?, ?)
      `).bind(id, check.employeeId, check.checkDate, check.institution, check.notes),
      ...resultStatements(context.env.DB, id, items),
    ]);
  } catch {
    throw new ApiError(409, "同一位員工在同一天已有健檢紀錄。");
  }
  return json(await readCheck(context.env.DB, id), 201);
}

/** PATCH 為整筆取代（含項目），與本專案其他模組的更新語意一致。 */
async function updateCheck(context: ApiContext, id: string): Promise<Response> {
  const body = await parseJson<HealthCheckInput>(context.request);
  const check = parseCheck(body);
  const items = parseResultItems(body);
  const existing = await context.env.DB.prepare("SELECT id FROM health_checks WHERE id = ?")
    .bind(id).first<{ id: string }>();
  if (!existing) throw new ApiError(404, "找不到指定健檢紀錄。");
  await assertEmployeeExists(context.env.DB, check.employeeId);
  await assertItemsExist(context.env.DB, items);

  try {
    await context.env.DB.batch([
      context.env.DB.prepare(`
        UPDATE health_checks
        SET employee_id = ?, check_date = ?, institution = ?, notes = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).bind(check.employeeId, check.checkDate, check.institution, check.notes, id),
      context.env.DB.prepare("DELETE FROM health_check_results WHERE health_check_id = ?").bind(id),
      ...resultStatements(context.env.DB, id, items),
    ]);
  } catch {
    throw new ApiError(409, "同一位員工在同一天已有健檢紀錄。");
  }
  return json(await readCheck(context.env.DB, id));
}

async function deleteCheck(context: ApiContext, id: string): Promise<Response> {
  const result = await context.env.DB.prepare("DELETE FROM health_checks WHERE id = ?")
    .bind(id).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定健檢紀錄。");
  return json({ id, deleted: true });
}

// ---------------------------------------------------------------------------
// 員工端：只查自己的
// ---------------------------------------------------------------------------

/**
 * 兩支查詢都把登入者的 employeeId 直接綁進 `WHERE`：
 * 紀錄查詢是 `WHERE hc.employee_id = ?`，下次應檢日是 dueQuery(true) 的 `WHERE e.id = ?`。
 * 一律不撈他人資料再過濾，任何路徑上的失誤都不會讓別人的特種個資進到回應裡。
 */
async function employeeHealthChecks(
  context: ApiContext,
  user: AuthUser & { employeeId: string },
): Promise<Response> {
  const reminderMonths = await healthCheckReminderMonths(context.env.DB);
  const [checks, summaryRow] = await Promise.all([
    context.env.DB.prepare(`
      SELECT hc.id, hc.employee_id AS employeeId, e.employee_no AS employeeNo,
             e.name AS employeeName, e.department,
             hc.check_date AS checkDate, hc.institution, hc.notes,
             hc.created_at AS createdAt, hc.updated_at AS updatedAt
      FROM health_checks hc
      JOIN employees e ON e.id = hc.employee_id
      WHERE hc.employee_id = ?
      ORDER BY date(hc.check_date) DESC
    `).bind(user.employeeId).all<HealthCheckRow>(),
    context.env.DB.prepare(dueQuery(true)).bind(user.employeeId).first<DueRow>(),
  ]);
  return json({
    reminderMonths,
    summary: summaryRow ? decorate(summaryRow, reminderMonths) : null,
    healthChecks: await attachResults(context.env.DB, checks.results),
  });
}

// ---------------------------------------------------------------------------
// 路由分派
// ---------------------------------------------------------------------------

export async function handleAdminHealthCheck(
  context: ApiContext,
  path: string,
): Promise<Response | null> {
  requireAdmin(context.user);
  const base = "/api/admin/health-check";
  if (!path.startsWith(base)) return null;
  const method = context.request.method;

  if (path === `${base}-items` && method === "GET") return listItems(context);
  if (path === `${base}-items` && method === "POST") return createItem(context);
  const itemMatch = path.match(/^\/api\/admin\/health-check-items\/([^/]+)$/);
  if (itemMatch?.[1] && method === "PATCH") return updateItem(context, itemMatch[1]);
  if (itemMatch?.[1] && method === "DELETE") return deleteItem(context, itemMatch[1]);

  // /due 必須排在 /{id} 之前，否則 "due" 會被當成健檢紀錄 id。
  if (path === `${base}s/due` && method === "GET") return listDue(context);

  if (path === `${base}s` && method === "GET") return listChecks(context);
  if (path === `${base}s` && method === "POST") return createCheck(context);
  const checkMatch = path.match(/^\/api\/admin\/health-checks\/([^/]+)$/);
  if (checkMatch?.[1] && method === "PATCH") return updateCheck(context, checkMatch[1]);
  if (checkMatch?.[1] && method === "DELETE") return deleteCheck(context, checkMatch[1]);

  return null;
}

export async function handleEmployeeHealthCheck(
  context: ApiContext,
  path: string,
): Promise<Response | null> {
  const user = requireEmployeeIdentity(context.user);
  if (path === "/api/employee/health-checks" && context.request.method === "GET") {
    return employeeHealthChecks(context, user);
  }
  return null;
}
