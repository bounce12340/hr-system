import { isValidIsoDate, parseCsvTable, parseNonNegativeNumber } from "./csv";
import { ApiError, json, optionalString, parseJson, requireAdmin, uuid } from "./http";
import { completionData, taipeiNow } from "./m1";
import { funnelData } from "./m3";
import type { ApiContext } from "./types";

const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const FALLBACK_PERIOD_MONTHS = 6;

/**
 * 報表通用篩選：部門、職等、期間（起迄月份）。
 * startDate／endDate／endDateExclusive 為由起迄月份推導的實際日期界線，
 * 供各指標直接綁進 SQL（期間一律「起日含、迄日不含」）。
 */
export interface ReportFilters {
  department: string | null;
  grade: string | null;
  startMonth: string;
  endMonth: string;
  startDate: string;
  endDate: string;
  endDateExclusive: string;
}

interface EmployeeScope {
  clause: string;
  bindings: string[];
}

interface HeadcountRow {
  department: string;
  grade: string;
  count: number;
}

interface TerminationRow {
  department: string;
  month: string;
  count: number;
}

interface AttendanceRow {
  month: string;
  department: string;
  source: "manual" | "csv";
  absenceType: string;
  records: number;
  absenceHours: number;
  overtimeHours: number;
}

interface SalaryRow {
  department: string;
  grade: string;
  headcount: number;
  totalSalary: number;
  missingSalary: number;
}

/** 某日仍在職：到職日已到，且尚未離職（離職當日仍計為在職）。 */
const ACTIVE_AS_OF = "e.hire_date <= ? AND (e.termination_date IS NULL OR e.termination_date > ?)";

function monthParam(value: string | null, label: string): string | null {
  if (value === null || value.trim() === "") return null;
  const normalized = value.trim();
  if (!MONTH_PATTERN.test(normalized)) {
    throw new ApiError(422, `${label} 參數格式須為 YYYY-MM。`);
  }
  return normalized;
}

function shiftMonth(month: string, delta: number): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1;
  const shifted = new Date(Date.UTC(year, index + delta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

function lastDayOfMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  const value = new Date(Date.UTC(year, index, 0));
  return value.toISOString().slice(0, 10);
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function defaultPeriodMonths(db: D1Database): Promise<number> {
  const row = await db.prepare(`
    SELECT setting_value AS settingValue FROM settings
    WHERE setting_key = 'report_default_period_months'
  `).first<{ settingValue: string }>();
  const value = Number(row?.settingValue ?? FALLBACK_PERIOD_MONTHS);
  return Number.isInteger(value) && value >= 1 && value <= 60 ? value : FALLBACK_PERIOD_MONTHS;
}

/**
 * 解析所有報表共用的 querystring 篩選。
 * 未給 endMonth 時以當月（Asia/Taipei）為迄月；未給 startMonth 時，依 settings
 * 的 report_default_period_months 往前回溯。
 */
export async function parseReportFilters(context: ApiContext): Promise<ReportFilters> {
  const params = context.url.searchParams;
  const department = optionalString(params.get("department"), "部門", 100) || null;
  const grade = optionalString(params.get("grade"), "職等", 50) || null;
  const startMonth = monthParam(params.get("startMonth"), "startMonth");
  const endMonth = monthParam(params.get("endMonth"), "endMonth");

  const currentMonth = taipeiNow().slice(0, 7);
  const resolvedEnd = endMonth ?? (startMonth && startMonth > currentMonth ? startMonth : currentMonth);
  let resolvedStart = startMonth;
  if (!resolvedStart) {
    resolvedStart = shiftMonth(resolvedEnd, 1 - (await defaultPeriodMonths(context.env.DB)));
  }
  if (resolvedStart > resolvedEnd) {
    throw new ApiError(422, "起始月份不可晚於結束月份。");
  }
  return {
    department,
    grade,
    startMonth: resolvedStart,
    endMonth: resolvedEnd,
    startDate: `${resolvedStart}-01`,
    endDate: lastDayOfMonth(resolvedEnd),
    endDateExclusive: `${shiftMonth(resolvedEnd, 1)}-01`,
  };
}

/** 產生員工維度（部門／職等）的 SQL 片段與 bind 參數，供各指標共用。 */
function employeeScope(filters: ReportFilters): EmployeeScope {
  const conditions: string[] = [];
  const bindings: string[] = [];
  if (filters.department) {
    conditions.push("e.department = ?");
    bindings.push(filters.department);
  }
  if (filters.grade) {
    conditions.push("e.grade = ?");
    bindings.push(filters.grade);
  }
  return {
    clause: conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : "",
    bindings,
  };
}

function sumCounts<T extends { count: number }>(rows: T[], field: keyof T): Array<{ name: string; count: number }> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const key = String(row[field]);
    totals.set(key, (totals.get(key) ?? 0) + row.count);
  }
  return [...totals.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function headcountRows(db: D1Database, filters: ReportFilters, asOf: string): Promise<HeadcountRow[]> {
  const scope = employeeScope(filters);
  const result = await db.prepare(`
    SELECT e.department, e.grade, COUNT(*) AS count
    FROM employees e
    WHERE ${ACTIVE_AS_OF}${scope.clause}
    GROUP BY e.department, e.grade
    ORDER BY e.department, e.grade
  `).bind(asOf, asOf, ...scope.bindings).all<HeadcountRow>();
  return result.results;
}

async function headcountTotal(db: D1Database, filters: ReportFilters, asOf: string): Promise<number> {
  const scope = employeeScope(filters);
  const row = await db.prepare(`
    SELECT COUNT(*) AS count FROM employees e
    WHERE ${ACTIVE_AS_OF}${scope.clause}
  `).bind(asOf, asOf, ...scope.bindings).first<{ count: number }>();
  return row?.count ?? 0;
}

/** 指標一：在職人數與人力結構（以期末為基準的快照，另附期初人數供對照）。 */
async function headcountReport(db: D1Database, filters: ReportFilters) {
  const [rows, startTotal] = await Promise.all([
    headcountRows(db, filters, filters.endDate),
    headcountTotal(db, filters, filters.startDate),
  ]);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return {
    asOfDate: filters.endDate,
    total,
    startTotal,
    netChange: total - startTotal,
    byDepartment: sumCounts(rows, "department").map((item) => ({ department: item.name, count: item.count })),
    byGrade: sumCounts(rows, "grade").map((item) => ({ grade: item.name, count: item.count })),
  };
}

/** 指標二：離職率＝期間內離職數 ÷ 平均在職數（期初、期末在職數的平均）。 */
async function turnoverReport(db: D1Database, filters: ReportFilters) {
  const scope = employeeScope(filters);
  const [terminations, startHeadcount, endHeadcount] = await Promise.all([
    db.prepare(`
      SELECT e.department, substr(e.termination_date, 1, 7) AS month, COUNT(*) AS count
      FROM employees e
      WHERE e.termination_date IS NOT NULL
        AND e.termination_date >= ? AND e.termination_date < ?${scope.clause}
      GROUP BY e.department, month
      ORDER BY month, e.department
    `).bind(filters.startDate, filters.endDateExclusive, ...scope.bindings).all<TerminationRow>(),
    headcountTotal(db, filters, filters.startDate),
    headcountTotal(db, filters, filters.endDate),
  ]);
  const rows = terminations.results;
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const averageHeadcount = (startHeadcount + endHeadcount) / 2;
  return {
    terminations: total,
    startHeadcount,
    endHeadcount,
    averageHeadcount: round(averageHeadcount),
    turnoverRate: averageHeadcount > 0 ? round((total / averageHeadcount) * 100) : 0,
    byDepartment: sumCounts(rows, "department").map((item) => ({
      department: item.name,
      terminations: item.count,
    })),
    byMonth: sumCounts(rows, "month").map((item) => ({ month: item.name, terminations: item.count })),
  };
}

/** 指標三：缺勤與加班統計（資料來源為 attendance 表，含手動輸入與 CSV 匯入）。 */
async function attendanceReport(db: D1Database, filters: ReportFilters) {
  const scope = employeeScope(filters);
  const bindings = [filters.startDate, filters.endDateExclusive, ...scope.bindings];
  const [grouped, distinct] = await Promise.all([
    db.prepare(`
      SELECT substr(a.attendance_date, 1, 7) AS month, e.department, a.source,
             COALESCE(a.absence_type, '') AS absenceType,
             COUNT(*) AS records,
             COALESCE(SUM(a.absence_hours), 0) AS absenceHours,
             COALESCE(SUM(a.overtime_hours), 0) AS overtimeHours
      FROM attendance a
      JOIN employees e ON e.id = a.employee_id
      WHERE a.attendance_date >= ? AND a.attendance_date < ?${scope.clause}
      GROUP BY month, e.department, a.source, absenceType
      ORDER BY month, e.department
    `).bind(...bindings).all<AttendanceRow>(),
    db.prepare(`
      SELECT COUNT(DISTINCT a.employee_id) AS count
      FROM attendance a
      JOIN employees e ON e.id = a.employee_id
      WHERE a.attendance_date >= ? AND a.attendance_date < ?${scope.clause}
    `).bind(...bindings).first<{ count: number }>(),
  ]);
  const rows = grouped.results;
  const totals = rows.reduce(
    (sum, row) => ({
      records: sum.records + row.records,
      absenceHours: sum.absenceHours + row.absenceHours,
      overtimeHours: sum.overtimeHours + row.overtimeHours,
    }),
    { records: 0, absenceHours: 0, overtimeHours: 0 },
  );

  const bucket = <K extends keyof AttendanceRow>(field: K) => {
    const map = new Map<string, { records: number; absenceHours: number; overtimeHours: number }>();
    for (const row of rows) {
      const key = String(row[field]);
      const entry = map.get(key) ?? { records: 0, absenceHours: 0, overtimeHours: 0 };
      entry.records += row.records;
      entry.absenceHours += row.absenceHours;
      entry.overtimeHours += row.overtimeHours;
      map.set(key, entry);
    }
    return [...map.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([name, entry]) => ({ name, ...entry }));
  };

  return {
    totals: {
      records: totals.records,
      employees: distinct?.count ?? 0,
      absenceHours: round(totals.absenceHours),
      overtimeHours: round(totals.overtimeHours),
    },
    byMonth: bucket("month").map(({ name, ...rest }) => ({ month: name, ...rest })),
    byDepartment: bucket("department").map(({ name, ...rest }) => ({ department: name, ...rest })),
    bySource: bucket("source").map(({ name, ...rest }) => ({ source: name, ...rest })),
    byAbsenceType: bucket("absenceType")
      .filter((entry) => entry.absenceHours > 0)
      .map(({ name, records, absenceHours }) => ({
        absenceType: name === "" ? null : name,
        records,
        absenceHours,
      })),
  };
}

/**
 * 指標四：招募漏斗。直接沿用 M3 的 funnelData（src/server/m3.ts），
 * 部門對應職缺所屬部門，期間對應應徵投遞時間；職等不適用（候選人尚非員工）。
 */
async function funnelReport(db: D1Database, filters: ReportFilters) {
  const result = await funnelData(db, {
    department: filters.department,
    appliedFrom: filters.startDate,
    appliedBefore: filters.endDateExclusive,
  });
  return { ...result, gradeFilterApplied: false };
}

/**
 * 指標五：教育訓練完成率。沿用 M1 的 completionData（src/server/m1.ts），
 * 以期末為「截至日」計算累計完成狀態；起月不適用（完成率為累計狀態非期間流量）。
 */
async function completionReport(db: D1Database, filters: ReportFilters) {
  const rows = await completionData(db, {
    department: filters.department,
    grade: filters.grade,
    completedBefore: filters.endDateExclusive,
  });
  const summarize = (items: typeof rows) => {
    const requiredTotal = items.reduce((sum, item) => sum + item.requiredCount, 0);
    const completedTotal = items.reduce((sum, item) => sum + item.completedCount, 0);
    return {
      employees: items.length,
      requiredTotal,
      completedTotal,
      completionRate: requiredTotal === 0 ? 100 : round((completedTotal / requiredTotal) * 100),
      fullyCompleted: items.filter((item) => item.completedCount === item.requiredCount).length,
    };
  };
  const departments = [...new Set(rows.map((row) => row.department))].sort((left, right) =>
    left.localeCompare(right),
  );
  return {
    asOfDate: filters.endDate,
    company: summarize(rows),
    byDepartment: departments.map((department) => ({
      department,
      ...summarize(rows.filter((row) => row.department === department)),
    })),
  };
}

/**
 * 指標六：薪資成本（admin-only，由 router 的 /api/admin/* 保護）。
 * 口徑為「期末仍在職者的月薪加總」，不含期間內已離職者。
 */
async function salaryCostReport(db: D1Database, filters: ReportFilters) {
  const scope = employeeScope(filters);
  const result = await db.prepare(`
    SELECT e.department, e.grade, COUNT(*) AS headcount,
           COALESCE(SUM(e.salary), 0) AS totalSalary,
           SUM(CASE WHEN e.salary IS NULL THEN 1 ELSE 0 END) AS missingSalary
    FROM employees e
    WHERE ${ACTIVE_AS_OF}${scope.clause}
    GROUP BY e.department, e.grade
    ORDER BY e.department, e.grade
  `).bind(filters.endDate, filters.endDate, ...scope.bindings).all<SalaryRow>();
  const rows = result.results;
  const headcount = rows.reduce((sum, row) => sum + row.headcount, 0);
  const totalSalary = rows.reduce((sum, row) => sum + row.totalSalary, 0);

  const bucket = (field: "department" | "grade") => {
    const map = new Map<string, { headcount: number; totalSalary: number }>();
    for (const row of rows) {
      const entry = map.get(row[field]) ?? { headcount: 0, totalSalary: 0 };
      entry.headcount += row.headcount;
      entry.totalSalary += row.totalSalary;
      map.set(row[field], entry);
    }
    return [...map.entries()].sort((left, right) => left[0].localeCompare(right[0]));
  };

  return {
    asOfDate: filters.endDate,
    headcount,
    totalSalary,
    averageSalary: headcount > 0 ? round(totalSalary / headcount) : 0,
    missingSalaryCount: rows.reduce((sum, row) => sum + row.missingSalary, 0),
    byDepartment: bucket("department").map(([department, entry]) => ({ department, ...entry })),
    byGrade: bucket("grade").map(([grade, entry]) => ({ grade, ...entry })),
  };
}

const ATTENDANCE_CSV_HEADERS = ["員工編號", "日期", "缺勤時數", "加班時數", "假別", "備註"] as const;

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
 * 缺勤加班 CSV 匯入（規格 §五 M4）。
 * 逐列驗證，任一列失敗只記錄該列錯誤並繼續處理下一列，整批回應固定 200。
 * 重複匯入（同員工同日期）採「更新」：以既有列為準覆寫時數／假別／備註，並把 source 改回 'csv'。
 */
async function importAttendance(context: ApiContext): Promise<Response> {
  const body = await parseJson<{ csv?: unknown }>(context.request);
  if (typeof body.csv !== "string" || body.csv.trim() === "") {
    throw new ApiError(400, "請提供 csv 欄位（CSV 檔案全文字串）。");
  }
  const table = parseCsvTable(body.csv, ATTENDANCE_CSV_HEADERS);
  const db = context.env.DB;
  const summary: ImportSummary = { imported: 0, updated: 0, skipped: 0, errors: [] };

  for (const row of table.rows) {
    const employeeNo = row.get("員工編號");
    const dateText = row.get("日期");
    const absenceText = row.get("缺勤時數");
    const overtimeText = row.get("加班時數");
    const absenceType = row.get("假別");
    const notes = row.get("備註");

    if (!employeeNo) {
      summary.errors.push({ row: row.rowNumber, message: "員工編號為必填。" });
      summary.skipped += 1;
      continue;
    }
    if (!dateText) {
      summary.errors.push({ row: row.rowNumber, message: "日期為必填。" });
      summary.skipped += 1;
      continue;
    }
    if (!isValidIsoDate(dateText)) {
      summary.errors.push({ row: row.rowNumber, message: "日期格式須為 YYYY-MM-DD。" });
      summary.skipped += 1;
      continue;
    }
    const absenceHours = parseNonNegativeNumber(absenceText, 0);
    if (absenceHours === null) {
      summary.errors.push({ row: row.rowNumber, message: "缺勤時數須為非負數字。" });
      summary.skipped += 1;
      continue;
    }
    const overtimeHours = parseNonNegativeNumber(overtimeText, 0);
    if (overtimeHours === null) {
      summary.errors.push({ row: row.rowNumber, message: "加班時數須為非負數字。" });
      summary.skipped += 1;
      continue;
    }

    const employee = await db.prepare(
      "SELECT id FROM employees WHERE employee_no = ?",
    ).bind(employeeNo).first<{ id: string }>();
    if (!employee) {
      summary.errors.push({ row: row.rowNumber, message: `找不到員工編號「${employeeNo}」的員工資料。` });
      summary.skipped += 1;
      continue;
    }

    const existing = await db.prepare(`
      SELECT id FROM attendance WHERE employee_id = ? AND attendance_date = ? ORDER BY id LIMIT 1
    `).bind(employee.id, dateText).first<{ id: string }>();

    if (existing) {
      await db.prepare(`
        UPDATE attendance SET absence_hours = ?, overtime_hours = ?, absence_type = ?, source = 'csv', notes = ?
        WHERE id = ?
      `).bind(absenceHours, overtimeHours, absenceType || null, notes, existing.id).run();
      summary.updated += 1;
    } else {
      await db.prepare(`
        INSERT INTO attendance (id, employee_id, attendance_date, absence_hours, overtime_hours, absence_type, source, notes)
        VALUES (?, ?, ?, ?, ?, ?, 'csv', ?)
      `).bind(uuid(), employee.id, dateText, absenceHours, overtimeHours, absenceType || null, notes).run();
      summary.imported += 1;
    }
  }

  return json(summary);
}

async function report(
  context: ApiContext,
  build: (db: D1Database, filters: ReportFilters) => Promise<unknown>,
): Promise<Response> {
  const filters = await parseReportFilters(context);
  return json({ filters, data: await build(context.env.DB, filters) });
}

async function summaryReport(context: ApiContext): Promise<Response> {
  const filters = await parseReportFilters(context);
  const db = context.env.DB;
  const [headcount, turnover, attendance, funnel, completion, salaryCost] = await Promise.all([
    headcountReport(db, filters),
    turnoverReport(db, filters),
    attendanceReport(db, filters),
    funnelReport(db, filters),
    completionReport(db, filters),
    salaryCostReport(db, filters),
  ]);
  return json({
    filters,
    data: { headcount, turnover, attendance, funnel, completion, salaryCost },
  });
}

export async function handleAdminM4(context: ApiContext, path: string): Promise<Response | null> {
  requireAdmin(context.user);
  const base = "/api/admin/reports";
  if (!path.startsWith(base)) return null;

  if (path === `${base}/attendance/import` && context.request.method === "POST") {
    return importAttendance(context);
  }
  if (context.request.method !== "GET") return null;

  if (path === `${base}/headcount`) return report(context, headcountReport);
  if (path === `${base}/turnover`) return report(context, turnoverReport);
  if (path === `${base}/attendance`) return report(context, attendanceReport);
  if (path === `${base}/recruitment-funnel`) return report(context, funnelReport);
  if (path === `${base}/training-completion`) return report(context, completionReport);
  if (path === `${base}/salary-cost`) return report(context, salaryCostReport);
  if (path === `${base}/summary`) return summaryReport(context);
  return null;
}
