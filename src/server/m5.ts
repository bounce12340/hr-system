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

// ---------------------------------------------------------------------------
// 值域與中文標籤
// ---------------------------------------------------------------------------
// readiness 的實際欄位值沿用 0001 schema 的 CHECK 約束（one_two_years／
// three_plus_years），與規格草稿使用的 1_2_years／3_plus_years 不同；因欄位
// 不能以數字開頭作為識別字，且 migration 已在使用中，故以 0001 為準。

type RiskLevel = "low" | "medium" | "high";
type Readiness = "ready_now" | "one_two_years" | "three_plus_years";
type IdpPlanStatus = "draft" | "active" | "completed" | "cancelled";
type IdpItemStatus = "pending" | "in_progress" | "completed";

const RISK_LABELS: Record<RiskLevel, string> = {
  low: "低",
  medium: "中",
  high: "高",
};

const READINESS_LABELS: Record<Readiness, string> = {
  ready_now: "立即可接任",
  one_two_years: "1-2 年內可接任",
  three_plus_years: "3 年以上可接任",
};

const IDP_PLAN_STATUS_LABELS: Record<IdpPlanStatus, string> = {
  draft: "草稿",
  active: "進行中",
  completed: "已完成",
  cancelled: "已取消",
};

const IDP_ITEM_STATUS_LABELS: Record<IdpItemStatus, string> = {
  pending: "待辦",
  in_progress: "進行中",
  completed: "已完成",
};

/**
 * 判斷是否為唯一鍵衝突。
 *
 * 存在理由：先前這裡是裸 `catch`，把任何寫入失敗都轉成「已存在」的 409。連線中斷、
 * 欄位型別錯誤、schema 不符都會被偽裝成重複資料，除錯時會被導向完全錯誤的方向。
 * 只有確認是唯一鍵衝突才轉 409，其餘原樣拋出，讓真正的錯誤浮上來。
 */
function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed");
}

function scoreLabel(value: number): string {
  if (value === 1) return "低";
  if (value === 2) return "中";
  return "高";
}

// ---------------------------------------------------------------------------
// 輸入解析與驗證
// ---------------------------------------------------------------------------

interface CompetencyInput {
  positionTitle?: unknown;
  competencyName?: unknown;
  requiredLevel?: unknown;
  description?: unknown;
}

interface NineGridInput {
  performance?: unknown;
  potential?: unknown;
  reviewPeriod?: unknown;
  notes?: unknown;
}

interface KeyPositionInput {
  title?: unknown;
  department?: unknown;
  incumbentEmployeeId?: unknown;
  riskLevel?: unknown;
  notes?: unknown;
}

interface SuccessorCreateInput {
  employeeId?: unknown;
  readiness?: unknown;
  notes?: unknown;
}

interface SuccessorUpdateInput {
  readiness?: unknown;
  notes?: unknown;
}

interface IdpPlanInput {
  employeeId?: unknown;
  title?: unknown;
  goal?: unknown;
  startDate?: unknown;
  dueDate?: unknown;
  status?: unknown;
}

interface IdpItemInput {
  action?: unknown;
  dueDate?: unknown;
  status?: unknown;
  employeeNotes?: unknown;
}

interface EmployeeIdpItemInput {
  status?: unknown;
  employeeNotes?: unknown;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ApiError(422, `${label}須為 ${min}～${max} 的整數。`);
  }
  return value;
}

function nullableId(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, label, 100);
}

function isoDate(value: unknown, label: string): string {
  const date = requiredString(value, label, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new ApiError(422, `${label}格式須為 YYYY-MM-DD。`);
  }
  return date;
}

function riskLevelValue(value: unknown): RiskLevel {
  if (value === undefined || value === null || value === "") return "medium";
  if (value === "low" || value === "medium" || value === "high") return value;
  throw new ApiError(422, "風險等級必須是 low、medium 或 high。");
}

function readinessValue(value: unknown): Readiness {
  if (value === "ready_now" || value === "one_two_years" || value === "three_plus_years") {
    return value;
  }
  throw new ApiError(422, "準備度必須是 ready_now、one_two_years 或 three_plus_years。");
}

function idpPlanStatusValue(value: unknown, fallback?: IdpPlanStatus): IdpPlanStatus {
  if (value === undefined && fallback !== undefined) return fallback;
  if (value === "draft" || value === "active" || value === "completed" || value === "cancelled") {
    return value;
  }
  throw new ApiError(422, "IDP 計畫狀態必須是 draft、active、completed 或 cancelled。");
}

function idpItemStatusValue(value: unknown, fallback?: IdpItemStatus): IdpItemStatus {
  if (value === undefined && fallback !== undefined) return fallback;
  if (value === "pending" || value === "in_progress" || value === "completed") return value;
  throw new ApiError(422, "IDP 項目狀態必須是 pending、in_progress 或 completed。");
}

function parseCompetency(body: CompetencyInput) {
  return {
    positionTitle: requiredString(body.positionTitle, "職位名稱", 200),
    competencyName: requiredString(body.competencyName, "職能項目", 200),
    requiredLevel: integer(body.requiredLevel, "必要職能等級", 1, 5),
    description: optionalString(body.description, "說明", 2000),
  };
}

function parseNineGrid(body: NineGridInput) {
  return {
    performance: integer(body.performance, "績效", 1, 3),
    potential: integer(body.potential, "潛力", 1, 3),
    reviewPeriod: requiredString(body.reviewPeriod, "評核期間", 100),
    notes: optionalString(body.notes, "備註", 2000),
  };
}

function parseKeyPosition(body: KeyPositionInput) {
  return {
    title: requiredString(body.title, "職位名稱", 200),
    department: requiredString(body.department, "部門", 200),
    incumbentEmployeeId: nullableId(body.incumbentEmployeeId, "現任人員"),
    riskLevel: riskLevelValue(body.riskLevel),
    notes: optionalString(body.notes, "備註", 2000),
  };
}

function parseIdpPlan(body: IdpPlanInput, defaultStatus?: IdpPlanStatus) {
  const startDate = isoDate(body.startDate, "起始日");
  const dueDate = isoDate(body.dueDate, "預計完成日");
  if (dueDate < startDate) {
    throw new ApiError(422, "預計完成日不可早於起始日。");
  }
  return {
    employeeId: requiredString(body.employeeId, "員工", 100),
    title: requiredString(body.title, "計畫名稱", 200),
    goal: requiredString(body.goal, "目標", 5000),
    startDate,
    dueDate,
    status: idpPlanStatusValue(body.status, defaultStatus),
  };
}

function parseIdpItem(body: IdpItemInput, defaultStatus?: IdpItemStatus) {
  return {
    action: requiredString(body.action, "行動項目", 500),
    dueDate: isoDate(body.dueDate, "期限"),
    status: idpItemStatusValue(body.status, defaultStatus),
    employeeNotes: optionalString(body.employeeNotes, "員工備註", 2000),
  };
}

// ---------------------------------------------------------------------------
// 共用存在性檢查
// ---------------------------------------------------------------------------

async function assertEmployeeExists(db: D1Database, id: string, label = "員工"): Promise<void> {
  const employee = await db.prepare("SELECT id FROM employees WHERE id = ?").bind(id).first();
  if (!employee) throw new ApiError(404, `找不到指定${label}。`);
}

async function assertKeyPositionExists(db: D1Database, id: string): Promise<void> {
  const position = await db.prepare("SELECT id FROM key_positions WHERE id = ?").bind(id).first();
  if (!position) throw new ApiError(404, "找不到指定關鍵職位。");
}

async function assertIdpPlanExists(db: D1Database, id: string): Promise<void> {
  const plan = await db.prepare("SELECT id FROM idp_plans WHERE id = ?").bind(id).first();
  if (!plan) throw new ApiError(404, "找不到指定 IDP 計畫。");
}

// ---------------------------------------------------------------------------
// 職能模型
// ---------------------------------------------------------------------------

async function listCompetencies(context: ApiContext): Promise<Response> {
  const result = await context.env.DB.prepare(`
    SELECT id, position_title AS positionTitle, competency_name AS competencyName,
           required_level AS requiredLevel, description
    FROM competency_models
    ORDER BY position_title, competency_name
  `).all();
  return json({ competencies: result.results });
}

async function createCompetency(context: ApiContext): Promise<Response> {
  const competency = parseCompetency(await parseJson<CompetencyInput>(context.request));
  const id = uuid();
  try {
    await context.env.DB.prepare(`
      INSERT INTO competency_models (id, position_title, competency_name, required_level, description)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      id,
      competency.positionTitle,
      competency.competencyName,
      competency.requiredLevel,
      competency.description,
    ).run();
  } catch (caught) {
    if (!isUniqueViolation(caught)) throw caught;
    throw new ApiError(409, "此職位已有相同職能項目。");
  }
  return json({ id, ...competency }, 201);
}

async function updateCompetency(context: ApiContext, id: string): Promise<Response> {
  const competency = parseCompetency(await parseJson<CompetencyInput>(context.request));
  try {
    const result = await context.env.DB.prepare(`
      UPDATE competency_models
      SET position_title = ?, competency_name = ?, required_level = ?, description = ?
      WHERE id = ?
    `).bind(
      competency.positionTitle,
      competency.competencyName,
      competency.requiredLevel,
      competency.description,
      id,
    ).run();
    if (result.meta.changes === 0) throw new ApiError(404, "找不到指定職能項目。");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(409, "此職位已有相同職能項目。");
  }
  return json({ id, ...competency });
}

async function deleteCompetency(context: ApiContext, id: string): Promise<Response> {
  const result = await context.env.DB.prepare("DELETE FROM competency_models WHERE id = ?").bind(id).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定職能項目。");
  return json({ id, deleted: true });
}

// ---------------------------------------------------------------------------
// 九宮格（績效 × 潛力）
// ---------------------------------------------------------------------------

interface NineGridRow {
  employeeId: string;
  employeeNo: string;
  name: string;
  department: string;
  title: string;
  performance: number | null;
  potential: number | null;
  reviewPeriod: string | null;
  notes: string | null;
  updatedAt: string | null;
}

async function listNineGrid(context: ApiContext): Promise<Response> {
  const result = await context.env.DB.prepare(`
    SELECT e.id AS employeeId, e.employee_no AS employeeNo, e.name, e.department, e.title,
           ng.performance, ng.potential, ng.review_period AS reviewPeriod, ng.notes,
           ng.updated_at AS updatedAt
    FROM employees e
    LEFT JOIN nine_grid ng ON ng.employee_id = e.id
    WHERE e.status = 'active'
    ORDER BY e.department, e.employee_no
  `).all<NineGridRow>();
  return json({
    // scale 是完整的 1～3 刻度對照，與 grid 內容無關。前端若改以現有資料反推標籤，
    // 沒有員工落在某一級時該級就會缺對照；全新環境 nine_grid 為空時更會整個軸失去
    // 標題，看不出哪軸是績效、哪軸是潛力。刻度是固定語意，必須由後端明確供給。
    scale: [1, 2, 3].map((value) => ({ value, label: scoreLabel(value) })),
    grid: result.results.map((row) => ({
      ...row,
      performanceLabel: row.performance === null ? null : scoreLabel(row.performance),
      potentialLabel: row.potential === null ? null : scoreLabel(row.potential),
    })),
  });
}

async function upsertNineGrid(context: ApiContext, employeeId: string): Promise<Response> {
  const grid = parseNineGrid(await parseJson<NineGridInput>(context.request));
  await assertEmployeeExists(context.env.DB, employeeId);
  const existing = await context.env.DB.prepare(
    "SELECT id FROM nine_grid WHERE employee_id = ?",
  ).bind(employeeId).first<{ id: string }>();
  const id = existing?.id ?? uuid();
  await context.env.DB.prepare(`
    INSERT INTO nine_grid (id, employee_id, performance, potential, review_period, notes)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(employee_id) DO UPDATE SET
      performance = excluded.performance,
      potential = excluded.potential,
      review_period = excluded.review_period,
      notes = excluded.notes,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).bind(id, employeeId, grid.performance, grid.potential, grid.reviewPeriod, grid.notes).run();
  return json({
    employeeId,
    ...grid,
    performanceLabel: scoreLabel(grid.performance),
    potentialLabel: scoreLabel(grid.potential),
  });
}

// ---------------------------------------------------------------------------
// 關鍵職位與繼任者
// ---------------------------------------------------------------------------

async function listKeyPositions(context: ApiContext): Promise<Response> {
  const result = await context.env.DB.prepare(`
    SELECT kp.id, kp.title, kp.department, kp.incumbent_employee_id AS incumbentEmployeeId,
           e.name AS incumbentName, kp.risk_level AS riskLevel, kp.notes,
           (SELECT COUNT(*) FROM successors s WHERE s.key_position_id = kp.id) AS successorCount
    FROM key_positions kp
    LEFT JOIN employees e ON e.id = kp.incumbent_employee_id
    ORDER BY kp.department, kp.title
  `).all<{ riskLevel: RiskLevel }>();
  return json({
    keyPositions: result.results.map((row) => ({
      ...row,
      riskLevelLabel: RISK_LABELS[row.riskLevel],
    })),
  });
}

async function createKeyPosition(context: ApiContext): Promise<Response> {
  const position = parseKeyPosition(await parseJson<KeyPositionInput>(context.request));
  if (position.incumbentEmployeeId) {
    await assertEmployeeExists(context.env.DB, position.incumbentEmployeeId, "現任人員");
  }
  const id = uuid();
  await context.env.DB.prepare(`
    INSERT INTO key_positions (id, title, department, incumbent_employee_id, risk_level, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    position.title,
    position.department,
    position.incumbentEmployeeId,
    position.riskLevel,
    position.notes,
  ).run();
  return json({ id, ...position, riskLevelLabel: RISK_LABELS[position.riskLevel] }, 201);
}

async function updateKeyPosition(context: ApiContext, id: string): Promise<Response> {
  const position = parseKeyPosition(await parseJson<KeyPositionInput>(context.request));
  if (position.incumbentEmployeeId) {
    await assertEmployeeExists(context.env.DB, position.incumbentEmployeeId, "現任人員");
  }
  const result = await context.env.DB.prepare(`
    UPDATE key_positions
    SET title = ?, department = ?, incumbent_employee_id = ?, risk_level = ?, notes = ?
    WHERE id = ?
  `).bind(
    position.title,
    position.department,
    position.incumbentEmployeeId,
    position.riskLevel,
    position.notes,
    id,
  ).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定關鍵職位。");
  return json({ id, ...position, riskLevelLabel: RISK_LABELS[position.riskLevel] });
}

async function deleteKeyPosition(context: ApiContext, id: string): Promise<Response> {
  const result = await context.env.DB.prepare("DELETE FROM key_positions WHERE id = ?").bind(id).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定關鍵職位。");
  return json({ id, deleted: true });
}

async function listSuccessorsForPosition(context: ApiContext, keyPositionId: string): Promise<Response> {
  await assertKeyPositionExists(context.env.DB, keyPositionId);
  const result = await context.env.DB.prepare(`
    SELECT s.id, s.key_position_id AS keyPositionId, s.employee_id AS employeeId,
           e.name, e.department, e.title, s.readiness, s.notes
    FROM successors s
    JOIN employees e ON e.id = s.employee_id
    WHERE s.key_position_id = ?
    ORDER BY CASE s.readiness
      WHEN 'ready_now' THEN 0
      WHEN 'one_two_years' THEN 1
      ELSE 2
    END, e.employee_no
  `).bind(keyPositionId).all<{ readiness: Readiness }>();
  return json({
    successors: result.results.map((row) => ({
      ...row,
      readinessLabel: READINESS_LABELS[row.readiness],
    })),
  });
}

async function createSuccessor(context: ApiContext, keyPositionId: string): Promise<Response> {
  await assertKeyPositionExists(context.env.DB, keyPositionId);
  const body = await parseJson<SuccessorCreateInput>(context.request);
  const successor = {
    employeeId: requiredString(body.employeeId, "員工", 100),
    readiness: readinessValue(body.readiness),
    notes: optionalString(body.notes, "備註", 2000),
  };
  await assertEmployeeExists(context.env.DB, successor.employeeId);
  const id = uuid();
  try {
    await context.env.DB.prepare(`
      INSERT INTO successors (id, key_position_id, employee_id, readiness, notes)
      VALUES (?, ?, ?, ?, ?)
    `).bind(id, keyPositionId, successor.employeeId, successor.readiness, successor.notes).run();
  } catch (caught) {
    if (!isUniqueViolation(caught)) throw caught;
    throw new ApiError(409, "此員工已是該職位的繼任者。");
  }
  return json(
    { id, keyPositionId, ...successor, readinessLabel: READINESS_LABELS[successor.readiness] },
    201,
  );
}

async function updateSuccessor(context: ApiContext, id: string): Promise<Response> {
  const body = await parseJson<SuccessorUpdateInput>(context.request);
  const readiness = readinessValue(body.readiness);
  const notes = optionalString(body.notes, "備註", 2000);
  const result = await context.env.DB.prepare(`
    UPDATE successors SET readiness = ?, notes = ? WHERE id = ?
  `).bind(readiness, notes, id).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定繼任者紀錄。");
  return json({ id, readiness, notes, readinessLabel: READINESS_LABELS[readiness] });
}

async function deleteSuccessor(context: ApiContext, id: string): Promise<Response> {
  const result = await context.env.DB.prepare("DELETE FROM successors WHERE id = ?").bind(id).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定繼任者紀錄。");
  return json({ id, deleted: true });
}

// ---------------------------------------------------------------------------
// IDP 個人發展計畫
// ---------------------------------------------------------------------------

interface IdpPlanRow {
  id: string;
  employeeId: string;
  employeeName?: string;
  department?: string;
  title: string;
  goal: string;
  startDate: string;
  dueDate: string;
  status: IdpPlanStatus;
  createdAt: string;
}

interface IdpItemRow {
  id: string;
  idpPlanId: string;
  action: string;
  dueDate: string;
  status: IdpItemStatus;
  employeeNotes: string;
}

async function attachIdpItems(db: D1Database, plans: IdpPlanRow[]) {
  if (plans.length === 0) return [];
  const placeholders = plans.map(() => "?").join(", ");
  const items = await db.prepare(`
    SELECT id, idp_plan_id AS idpPlanId, action, due_date AS dueDate, status,
           employee_notes AS employeeNotes
    FROM idp_items
    WHERE idp_plan_id IN (${placeholders})
    ORDER BY due_date
  `).bind(...plans.map((plan) => plan.id)).all<IdpItemRow>();
  return plans.map((plan) => ({
    ...plan,
    statusLabel: IDP_PLAN_STATUS_LABELS[plan.status],
    items: items.results
      .filter((item) => item.idpPlanId === plan.id)
      .map((item) => ({ ...item, statusLabel: IDP_ITEM_STATUS_LABELS[item.status] })),
  }));
}

async function listIdpPlans(context: ApiContext): Promise<Response> {
  const employeeId = context.url.searchParams.get("employeeId");
  const where = employeeId ? "WHERE p.employee_id = ?" : "";
  const statement = context.env.DB.prepare(`
    SELECT p.id, p.employee_id AS employeeId, e.name AS employeeName, e.department,
           p.title, p.goal, p.start_date AS startDate, p.due_date AS dueDate,
           p.status, p.created_at AS createdAt
    FROM idp_plans p
    JOIN employees e ON e.id = p.employee_id
    ${where}
    ORDER BY p.created_at DESC
  `);
  const result = employeeId
    ? await statement.bind(employeeId).all<IdpPlanRow>()
    : await statement.all<IdpPlanRow>();
  return json({ idpPlans: await attachIdpItems(context.env.DB, result.results) });
}

async function createIdpPlan(context: ApiContext): Promise<Response> {
  const plan = parseIdpPlan(await parseJson<IdpPlanInput>(context.request), "active");
  await assertEmployeeExists(context.env.DB, plan.employeeId);
  const id = uuid();
  await context.env.DB.prepare(`
    INSERT INTO idp_plans (id, employee_id, title, goal, start_date, due_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(id, plan.employeeId, plan.title, plan.goal, plan.startDate, plan.dueDate, plan.status).run();
  return json({ id, ...plan }, 201);
}

async function updateIdpPlan(context: ApiContext, id: string): Promise<Response> {
  const plan = parseIdpPlan(await parseJson<IdpPlanInput>(context.request));
  await assertEmployeeExists(context.env.DB, plan.employeeId);
  const result = await context.env.DB.prepare(`
    UPDATE idp_plans
    SET employee_id = ?, title = ?, goal = ?, start_date = ?, due_date = ?, status = ?
    WHERE id = ?
  `).bind(plan.employeeId, plan.title, plan.goal, plan.startDate, plan.dueDate, plan.status, id).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定 IDP 計畫。");
  return json({ id, ...plan });
}

async function deleteIdpPlan(context: ApiContext, id: string): Promise<Response> {
  const result = await context.env.DB.prepare("DELETE FROM idp_plans WHERE id = ?").bind(id).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定 IDP 計畫。");
  return json({ id, deleted: true });
}

async function createIdpItem(context: ApiContext, planId: string): Promise<Response> {
  await assertIdpPlanExists(context.env.DB, planId);
  const item = parseIdpItem(await parseJson<IdpItemInput>(context.request), "pending");
  const id = uuid();
  await context.env.DB.prepare(`
    INSERT INTO idp_items (id, idp_plan_id, action, due_date, status, employee_notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(id, planId, item.action, item.dueDate, item.status, item.employeeNotes).run();
  return json({ id, idpPlanId: planId, ...item }, 201);
}

async function updateIdpItemAdmin(context: ApiContext, id: string): Promise<Response> {
  const item = parseIdpItem(await parseJson<IdpItemInput>(context.request));
  const result = await context.env.DB.prepare(`
    UPDATE idp_items SET action = ?, due_date = ?, status = ?, employee_notes = ? WHERE id = ?
  `).bind(item.action, item.dueDate, item.status, item.employeeNotes, id).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定 IDP 項目。");
  return json({ id, ...item });
}

async function deleteIdpItem(context: ApiContext, id: string): Promise<Response> {
  const result = await context.env.DB.prepare("DELETE FROM idp_items WHERE id = ?").bind(id).run();
  if (result.meta.changes === 0) throw new ApiError(404, "找不到指定 IDP 項目。");
  return json({ id, deleted: true });
}

// ---------------------------------------------------------------------------
// 員工端：自己的 IDP
// ---------------------------------------------------------------------------

async function employeeIdp(
  context: ApiContext,
  user: AuthUser & { employeeId: string },
): Promise<Response> {
  const result = await context.env.DB.prepare(`
    SELECT p.id, p.employee_id AS employeeId, p.title, p.goal,
           p.start_date AS startDate, p.due_date AS dueDate, p.status, p.created_at AS createdAt
    FROM idp_plans p
    WHERE p.employee_id = ?
    ORDER BY p.created_at DESC
  `).bind(user.employeeId).all<IdpPlanRow>();
  return json({ idpPlans: await attachIdpItems(context.env.DB, result.results) });
}

/**
 * 員工只能更新自己名下 IDP 項目，且僅能改 status 與 employeeNotes；
 * 無論 body 是否夾帶其他欄位（如 action、dueDate），一律不會被寫入。
 */
async function updateOwnIdpItem(
  context: ApiContext,
  user: AuthUser & { employeeId: string },
  itemId: string,
): Promise<Response> {
  const body = await parseJson<EmployeeIdpItemInput>(context.request);
  const status = idpItemStatusValue(body.status);
  const employeeNotes = optionalString(body.employeeNotes, "員工備註", 2000);
  const owned = await context.env.DB.prepare(`
    SELECT i.id FROM idp_items i
    JOIN idp_plans p ON p.id = i.idp_plan_id
    WHERE i.id = ? AND p.employee_id = ?
  `).bind(itemId, user.employeeId).first();
  if (!owned) throw new ApiError(404, "找不到指定 IDP 項目。");
  await context.env.DB.prepare(`
    UPDATE idp_items SET status = ?, employee_notes = ? WHERE id = ?
  `).bind(status, employeeNotes, itemId).run();
  return json({ id: itemId, status, employeeNotes, statusLabel: IDP_ITEM_STATUS_LABELS[status] });
}

// ---------------------------------------------------------------------------
// 路由分派
// ---------------------------------------------------------------------------

export async function handleAdminM5(context: ApiContext, path: string): Promise<Response | null> {
  requireAdmin(context.user);
  const base = "/api/admin/talent";
  if (!path.startsWith(base)) return null;
  const method = context.request.method;

  if (path === `${base}/competencies` && method === "GET") return listCompetencies(context);
  if (path === `${base}/competencies` && method === "POST") return createCompetency(context);
  const competencyMatch = path.match(/^\/api\/admin\/talent\/competencies\/([^/]+)$/);
  if (competencyMatch?.[1] && method === "PATCH") return updateCompetency(context, competencyMatch[1]);
  if (competencyMatch?.[1] && method === "DELETE") return deleteCompetency(context, competencyMatch[1]);

  if (path === `${base}/nine-grid` && method === "GET") return listNineGrid(context);
  const nineGridMatch = path.match(/^\/api\/admin\/talent\/nine-grid\/([^/]+)$/);
  if (nineGridMatch?.[1] && method === "PUT") return upsertNineGrid(context, nineGridMatch[1]);

  if (path === `${base}/key-positions` && method === "GET") return listKeyPositions(context);
  if (path === `${base}/key-positions` && method === "POST") return createKeyPosition(context);
  const successorsListMatch = path.match(/^\/api\/admin\/talent\/key-positions\/([^/]+)\/successors$/);
  if (successorsListMatch?.[1] && method === "GET") {
    return listSuccessorsForPosition(context, successorsListMatch[1]);
  }
  if (successorsListMatch?.[1] && method === "POST") {
    return createSuccessor(context, successorsListMatch[1]);
  }
  const keyPositionMatch = path.match(/^\/api\/admin\/talent\/key-positions\/([^/]+)$/);
  if (keyPositionMatch?.[1] && method === "PATCH") return updateKeyPosition(context, keyPositionMatch[1]);
  if (keyPositionMatch?.[1] && method === "DELETE") return deleteKeyPosition(context, keyPositionMatch[1]);

  const successorMatch = path.match(/^\/api\/admin\/talent\/successors\/([^/]+)$/);
  if (successorMatch?.[1] && method === "PATCH") return updateSuccessor(context, successorMatch[1]);
  if (successorMatch?.[1] && method === "DELETE") return deleteSuccessor(context, successorMatch[1]);

  if (path === `${base}/idp-plans` && method === "GET") return listIdpPlans(context);
  if (path === `${base}/idp-plans` && method === "POST") return createIdpPlan(context);
  const idpItemsCreateMatch = path.match(/^\/api\/admin\/talent\/idp-plans\/([^/]+)\/items$/);
  if (idpItemsCreateMatch?.[1] && method === "POST") {
    return createIdpItem(context, idpItemsCreateMatch[1]);
  }
  const idpPlanMatch = path.match(/^\/api\/admin\/talent\/idp-plans\/([^/]+)$/);
  if (idpPlanMatch?.[1] && method === "PATCH") return updateIdpPlan(context, idpPlanMatch[1]);
  if (idpPlanMatch?.[1] && method === "DELETE") return deleteIdpPlan(context, idpPlanMatch[1]);

  const idpItemMatch = path.match(/^\/api\/admin\/talent\/idp-items\/([^/]+)$/);
  if (idpItemMatch?.[1] && method === "PATCH") return updateIdpItemAdmin(context, idpItemMatch[1]);
  if (idpItemMatch?.[1] && method === "DELETE") return deleteIdpItem(context, idpItemMatch[1]);

  return null;
}

export async function handleEmployeeM5(context: ApiContext, path: string): Promise<Response | null> {
  const user = requireEmployeeIdentity(context.user);
  if (path === "/api/employee/idp" && context.request.method === "GET") {
    return employeeIdp(context, user);
  }
  const itemMatch = path.match(/^\/api\/employee\/idp\/items\/([^/]+)$/);
  if (itemMatch?.[1] && context.request.method === "PATCH") {
    return updateOwnIdpItem(context, user, itemMatch[1]);
  }
  return null;
}
