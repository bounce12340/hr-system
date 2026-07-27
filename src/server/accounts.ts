import { unusableCredentials } from "./auth";
import { ApiError, json, parseJson, requireAdmin, requiredString, uuid } from "./http";
import { issuePasswordSetup, type PasswordSetupDelivery } from "./password-setup";
import type { ApiContext, AuthUser, Role } from "./types";

/**
 * 登入帳號生命週期管理（規格 §七 系統設定：帳號管理）。
 *
 * 三個關鍵決策，改動前請先讀完：
 *
 * 1. 系統不再產生任何明碼密碼。建立帳號與重設密碼都只寫入一組**無法通過驗證**的
 *    隨機憑證（auth.ts unusableCredentials），真正的密碼由本人透過一次性設定連結
 *    自行設定（見 password-setup.ts）。舊版會回傳 temporaryPassword 讓 admin 轉達，
 *    已完整移除、不保留相容路徑：只要明碼存在過，它就會被截圖、轉貼、留在信箱裡。
 *
 * 2. 停用等於立即失效，不是等 session 過期。users.active 雖已在登入
 *    （auth.ts loadUserByEmail）與 session 驗證（auth.ts authenticate）兩處被檢查，
 *    但既有 sessions 列還在——只要 cookie 還沒過期就仍可能被其他路徑接受。
 *    因此所有會奪權的操作（停用、重設密碼、封存、刪除、離職連動）一律同時刪 sessions。
 *
 * 3. 刪除由系統判斷實刪或封存。判斷依據是 AUDIT_REFERENCES 這份稽核關聯清單，
 *    對照 `grep -n "REFERENCES users(id)" migrations/*.sql` 的結果扣掉
 *    sessions.user_id（ON DELETE CASCADE，屬於登入狀態不是稽核軌跡）。
 */

// ---------------------------------------------------------------------------
// 稽核關聯
// ---------------------------------------------------------------------------

/**
 * 所有指向 users(id) 且屬於「稽核軌跡」的外鍵。
 *
 * 完整來源：migrations/0001_initial_schema.sql:45／89／102／139／215／343、
 * migrations/0004_m2_enrollment_review.sql:1、migrations/0005_m3_recruitment.sql:64／99。
 * 其中 0001:45 是 sessions.user_id（CASCADE，不計入）、
 * 0001:215 是 candidate_status_history，已於 0006:74 DROP，因此不在清單內。
 *
 * NOT NULL 的四張表（course_sessions／special_days／conflict_overrides／
 * candidate_application_status_history）本來就刪不掉，nullable 的三張
 * （audit_logs／enrollments／salary_approvals）技術上可以 SET NULL，
 * 但那等於抹掉「是誰做的」，違反保留稽核軌跡的目的，因此一併算進來改走封存。
 */
const AUDIT_REFERENCES: ReadonlyArray<{ table: string; column: string }> = [
  { table: "course_sessions", column: "created_by" },
  { table: "special_days", column: "created_by" },
  { table: "conflict_overrides", column: "overridden_by" },
  { table: "candidate_application_status_history", column: "changed_by" },
  { table: "audit_logs", column: "actor_user_id" },
  { table: "enrollments", column: "reviewed_by" },
  { table: "salary_approvals", column: "approved_by" },
];

/** 由上方常數清單組出，沒有任何外部輸入進入 SQL 字串。 */
const AUDIT_REF_COUNT_SQL = AUDIT_REFERENCES
  .map(({ table, column }) => `(SELECT COUNT(*) FROM ${table} WHERE ${column} = u.id)`)
  .join(" + ");

// ---------------------------------------------------------------------------
// 查詢與輸出形狀
// ---------------------------------------------------------------------------

interface AccountRow {
  id: string;
  email: string;
  role: Role;
  active: number;
  mustChangePassword: number;
  employeeId: string | null;
  employeeNo: string | null;
  employeeName: string | null;
  employeeDepartment: string | null;
  employeeStatus: "active" | "inactive" | null;
  auditRefCount: number;
}

interface PublicAccount {
  id: string;
  email: string;
  role: Role;
  active: boolean;
  mustChangePassword: boolean;
  employeeId: string | null;
  employeeNo: string | null;
  employeeName: string | null;
  employeeDepartment: string | null;
  employeeStatus: "active" | "inactive" | null;
  employeeStatusLabel: string | null;
  auditRefCount: number;
}

const ACCOUNT_SELECT = `
  SELECT u.id, u.email, u.role, u.active,
         u.must_change_password AS mustChangePassword,
         u.employee_id AS employeeId,
         e.employee_no AS employeeNo, e.name AS employeeName,
         e.department AS employeeDepartment, e.status AS employeeStatus,
         ${AUDIT_REF_COUNT_SQL} AS auditRefCount
  FROM users u
  LEFT JOIN employees e ON e.id = u.employee_id
`;

/**
 * employeeStatus 回傳資料庫原值（active／inactive），與
 * GET /api/admin/employees 的 status 一致；employeeStatusLabel 另外附上
 * 繁中字樣，前端要直接顯示或自行對照都可以。
 */
function publicAccount(row: AccountRow): PublicAccount {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    active: row.active === 1,
    mustChangePassword: row.mustChangePassword === 1,
    employeeId: row.employeeId,
    employeeNo: row.employeeNo,
    employeeName: row.employeeName,
    employeeDepartment: row.employeeDepartment,
    employeeStatus: row.employeeStatus,
    employeeStatusLabel: row.employeeStatus === "active"
      ? "在職"
      : row.employeeStatus === "inactive"
        ? "離職"
        : null,
    auditRefCount: row.auditRefCount,
  };
}

/** 封存帳號一律視為不存在：清單不列、單筆查詢回 404，等同已刪除。 */
async function getAccount(db: D1Database, id: string): Promise<PublicAccount> {
  const row = await db.prepare(`${ACCOUNT_SELECT} WHERE u.id = ? AND u.archived_at IS NULL`)
    .bind(id).first<AccountRow>();
  if (!row) throw new ApiError(404, "找不到指定的登入帳號。");
  return publicAccount(row);
}

function auditLog(
  db: D1Database,
  actorId: string,
  action: string,
  targetUserId: string,
  details: Record<string, unknown>,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, details)
    VALUES (?, ?, ?, 'user', ?, ?)
  `).bind(uuid(), actorId, action, targetUserId, JSON.stringify(details));
}

function deleteSessions(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId);
}

// ---------------------------------------------------------------------------
// 端點
// ---------------------------------------------------------------------------

async function listAccounts(context: ApiContext): Promise<Response> {
  const result = await context.env.DB.prepare(`
    ${ACCOUNT_SELECT}
    WHERE u.archived_at IS NULL
    ORDER BY CASE u.role WHEN 'admin' THEN 0 ELSE 1 END,
             e.department, e.employee_no, u.email
  `).all<AccountRow>();
  return json({ users: result.results.map(publicAccount) });
}

interface CreateAccountBody {
  employeeId?: unknown;
  email?: unknown;
  role?: unknown;
}

interface UpdateAccountBody {
  role?: unknown;
  active?: unknown;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseRole(value: unknown): Role {
  if (value === "admin" || value === "employee") return value;
  throw new ApiError(422, "角色必須是 admin 或 employee。");
}

/**
 * 建立登入帳號。密碼欄位先填入無法通過驗證的隨機憑證，帳號在本人用設定連結
 * 設好密碼之前登不進來；email 省略時沿用員工主檔的聯絡信箱。
 */
async function createAccount(context: ApiContext, admin: AuthUser): Promise<Response> {
  const db = context.env.DB;
  const body = await parseJson<CreateAccountBody>(context.request);
  const employeeId = requiredString(body.employeeId, "員工", 100);
  const role = parseRole(body.role);

  const employee = await db.prepare(
    "SELECT id, email, status FROM employees WHERE id = ?",
  ).bind(employeeId).first<{ id: string; email: string; status: "active" | "inactive" }>();
  if (!employee) throw new ApiError(404, "找不到指定員工。");
  if (employee.status !== "active") {
    throw new ApiError(422, "此員工已離職，無法建立登入帳號。如需復職請先將員工狀態改回在職。");
  }

  const email = (
    body.email === undefined || body.email === null || body.email === ""
      ? employee.email
      : requiredString(body.email, "電子郵件", 200)
  ).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new ApiError(422, "電子郵件格式不正確。");

  // employee_id 與 email 都是 UNIQUE，先查一次是為了給出「哪一個撞到」的訊息；
  // 真正的併發保護仍靠下面 INSERT 的 catch。
  const employeeTaken = await db.prepare(
    "SELECT id FROM users WHERE employee_id = ?",
  ).bind(employeeId).first();
  if (employeeTaken) throw new ApiError(409, "此員工已有登入帳號。");
  const emailTaken = await db.prepare(
    "SELECT id FROM users WHERE email = ? COLLATE NOCASE",
  ).bind(email).first();
  if (emailTaken) throw new ApiError(409, "此電子郵件已被其他帳號使用。");

  // 帳號一建立就有一組沒有人知道（也不可能猜到）的密碼，must_change_password = 1
  // 標記「尚未由本人設定過」。在設定連結被使用之前，這個帳號登不進來。
  const credentials = unusableCredentials();
  const id = uuid();
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO users (
          id, employee_id, email, password_hash, password_salt, password_iterations,
          role, must_change_password, active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)
      `).bind(
        id, employeeId, email, credentials.hash, credentials.salt, credentials.iterations, role,
      ),
      // details 只記角色與 email 派送方式，絕不記 token 或任何密碼。
      auditLog(db, admin.id, "user.create", id, { employeeId, role, credentialDelivery: "setup_link" }),
    ]);
  } catch {
    throw new ApiError(409, "此員工或電子郵件已有帳號。");
  }

  const account = await getAccount(db, id);
  return withSetupDelivery(
    account,
    await issuePasswordSetup(context.env, db, { id, email }, "account_setup"),
    201,
  );
}

/**
 * 建立帳號與重設密碼共用的回應組裝。
 *
 * 契約形狀是 `{ user, mail: { status, message }, setupUrl? }`；帳號欄位同時攤平在
 * 頂層是沿用舊版行為（前端的容錯解析兩種都吃）。setupUrl 只在信沒有真的寄出去時
 * 才出現——寄成功了就沒有理由讓連結多留一份在 admin 畫面上。
 *
 * 寄信結果一律以 200／201 回應：帳號在這之前已經寫進資料庫了，用 5xx 表達
 * 「信沒寄成功」會讓 admin 誤判整件事失敗而重試，反而製造重複帳號。
 */
function withSetupDelivery(
  account: PublicAccount,
  delivery: PasswordSetupDelivery,
  status: number,
): Response {
  return json({
    ...account,
    user: account,
    mail: delivery.mail,
    setupExpiresAt: delivery.expiresAt,
    ...(delivery.setupUrl ? { setupUrl: delivery.setupUrl } : {}),
  }, status);
}

/**
 * 改角色／啟用停用。停用時同步刪除該帳號所有 sessions，讓停權即刻生效。
 * admin 不可停用或降級自己：兩者都會把自己鎖在系統外，且無法自救。
 */
async function updateAccount(context: ApiContext, admin: AuthUser, id: string): Promise<Response> {
  const db = context.env.DB;
  const current = await getAccount(db, id);
  const body = await parseJson<UpdateAccountBody>(context.request);

  const role = body.role === undefined ? current.role : parseRole(body.role);
  let active = current.active;
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") throw new ApiError(422, "啟用狀態須為布林值。");
    active = body.active;
  }

  if (id === admin.id) {
    if (!active) {
      throw new ApiError(422, "不可停用自己正在使用的帳號，否則將無人可以恢復系統管理權限。");
    }
    if (role !== current.role) {
      throw new ApiError(422, "不可變更自己的角色，否則會立即失去管理權限。請由另一位管理員操作。");
    }
  }

  const statements = [
    db.prepare("UPDATE users SET role = ?, active = ? WHERE id = ?")
      .bind(role, active ? 1 : 0, id),
  ];
  if (!active) statements.push(deleteSessions(db, id));
  statements.push(auditLog(db, admin.id, active ? "user.update" : "user.deactivate", id, {
    role,
    active,
    previousRole: current.role,
    previousActive: current.active,
  }));
  await db.batch(statements);

  const account = await getAccount(db, id);
  return json({ ...account, user: account });
}

/**
 * 重設密碼。舊密碼立刻換成無法通過驗證的隨機憑證（而不是換成另一組明碼臨時密碼），
 * 並且 must_change_password = 1、刪除所有既有 sessions——舊密碼配發出去的登入狀態
 * 必須一併作廢，否則「重設密碼」擋不住已經在線上的人。
 *
 * 新密碼由本人透過一次性設定連結自行設定。注意這代表帳號在連結被使用之前是
 * 登不進來的：這是刻意的取捨，重設密碼的情境本來就假設舊密碼已不可信。
 */
async function resetPassword(context: ApiContext, admin: AuthUser, id: string): Promise<Response> {
  const db = context.env.DB;
  const target = await getAccount(db, id);
  const credentials = unusableCredentials();
  await db.batch([
    db.prepare(`
      UPDATE users
      SET password_hash = ?, password_salt = ?, password_iterations = ?, must_change_password = 1
      WHERE id = ?
    `).bind(credentials.hash, credentials.salt, credentials.iterations, id),
    deleteSessions(db, id),
    auditLog(db, admin.id, "user.reset_password", id, { credentialDelivery: "setup_link" }),
  ]);
  const account = await getAccount(db, id);
  return withSetupDelivery(
    account,
    await issuePasswordSetup(context.env, db, { id, email: target.email }, "password_reset"),
    200,
  );
}

async function auditRefCount(db: D1Database, id: string): Promise<number> {
  const row = await db.prepare(
    `SELECT ${AUDIT_REF_COUNT_SQL} AS auditRefCount FROM users u WHERE u.id = ?`,
  ).bind(id).first<{ auditRefCount: number }>();
  return row?.auditRefCount ?? 0;
}

/**
 * 刪除或封存。系統自行判斷：
 *   auditRefCount = 0 → 實體刪除（sessions 由 ON DELETE CASCADE 帶走，此處仍明寫一句
 *                       以免日後外鍵定義改變）。
 *   auditRefCount > 0 → 封存（匿名化）：保留列與 id 讓稽核軌跡不斷，但
 *                       email 換成 @archived.invalid（RFC 2606 保留 TLD，不可能與真實信箱衝突
 *                       且一眼看得出是封存）、密碼換成無法通過驗證的隨機值、active = 0、
 *                       employee_id 清空（否則 UNIQUE 會擋住同一員工重新建帳號，
 *                       原值改存 archived_employee_id）、刪除 sessions。
 */
async function deleteAccount(context: ApiContext, admin: AuthUser, id: string): Promise<Response> {
  const db = context.env.DB;
  const account = await getAccount(db, id);
  if (id === admin.id) {
    throw new ApiError(422, "不可刪除自己正在使用的帳號，否則將無人可以恢復系統管理權限。");
  }

  const references = await auditRefCount(db, id);
  if (references === 0) {
    await db.batch([
      deleteSessions(db, id),
      auditLog(db, admin.id, "user.delete", id, { email: account.email, mode: "deleted" }),
      db.prepare("DELETE FROM users WHERE id = ?").bind(id),
    ]);
    return json({
      id,
      mode: "deleted",
      auditRefCount: 0,
      message: `帳號「${account.email}」沒有稽核關聯，已完整刪除。`,
    });
  }

  const credentials = unusableCredentials();
  await db.batch([
    db.prepare(`
      UPDATE users
      SET email = ?, password_hash = ?, password_salt = ?, password_iterations = ?,
          active = 0, must_change_password = 1,
          archived_employee_id = employee_id, employee_id = NULL,
          archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).bind(
      `archived+${id}@archived.invalid`,
      credentials.hash,
      credentials.salt,
      credentials.iterations,
      id,
    ),
    deleteSessions(db, id),
    auditLog(db, admin.id, "user.archive", id, {
      email: account.email,
      mode: "archived",
      auditRefCount: references,
      employeeId: account.employeeId,
    }),
  ]);
  return json({
    id,
    mode: "archived",
    auditRefCount: references,
    message: `帳號「${account.email}」有 ${references} 筆稽核關聯無法刪除，已改為封存：帳號立即停權且無法再登入，稽核紀錄仍保留。`,
  });
}

// ---------------------------------------------------------------------------
// 員工職責查詢（刪除／停用帳號前確認有沒有需要移轉的責任）
// ---------------------------------------------------------------------------

interface KeyPositionRow {
  id: string;
  title: string;
  department: string;
  riskLevel: "low" | "medium" | "high";
  notes: string;
}

interface SuccessorRow {
  id: string;
  keyPositionId: string;
  title: string;
  department: string;
  riskLevel: "low" | "medium" | "high";
  readiness: string;
  notes: string;
}

const READINESS_LABELS: Record<string, string> = {
  ready_now: "可立即接任",
  one_two_years: "1～2 年後可接任",
  three_plus_years: "3 年以上",
};

/**
 * 本系統只有兩處把「職責」綁在 employees.id 上：
 *   key_positions.incumbent_employee_id（關鍵職位現任者）
 *   successors.employee_id（繼任人選）
 * 其餘如 courses.instructor、interviews.interviewer_name 都是純文字欄位、不綁 ID，
 * 無從也不需要移轉，因此不在回傳範圍內。
 *
 * 回應刻意只給 responsibilities 一個攤平清單，每筆自帶 relation 標記，
 * 不再另外附上 incumbentOf／successorOf 之類的分組陣列：前端的容錯解析
 * （src/client/pages/EmployeeAdminPages.tsx normalizeResponsibilities）
 * 會把攤平清單與分組陣列「相加」，兩種都給會讓繼任者被重複計算一次。
 */
async function employeeResponsibilities(context: ApiContext, employeeId: string): Promise<Response> {
  const db = context.env.DB;
  const employee = await db.prepare(`
    SELECT id, employee_no AS employeeNo, name, department, title, status
    FROM employees WHERE id = ?
  `).bind(employeeId).first<{
    id: string;
    employeeNo: string;
    name: string;
    department: string;
    title: string;
    status: "active" | "inactive";
  }>();
  if (!employee) throw new ApiError(404, "找不到指定員工。");

  const [positions, successors] = await Promise.all([
    db.prepare(`
      SELECT id, title, department, risk_level AS riskLevel, notes
      FROM key_positions WHERE incumbent_employee_id = ?
      ORDER BY department, title
    `).bind(employeeId).all<KeyPositionRow>(),
    db.prepare(`
      SELECT s.id, s.key_position_id AS keyPositionId, kp.title, kp.department,
             kp.risk_level AS riskLevel, s.readiness, s.notes
      FROM successors s
      JOIN key_positions kp ON kp.id = s.key_position_id
      WHERE s.employee_id = ?
      ORDER BY kp.department, kp.title
    `).bind(employeeId).all<SuccessorRow>(),
  ]);

  const responsibilities = [
    ...positions.results.map((row) => ({
      relation: "incumbent" as const,
      relationLabel: "關鍵職位現任者",
      keyPositionId: row.id,
      keyPositionTitle: row.title,
      title: row.title,
      department: row.department,
      riskLevel: row.riskLevel,
      readiness: null,
      readinessLabel: null,
      notes: row.notes,
    })),
    ...successors.results.map((row) => ({
      relation: "successor" as const,
      relationLabel: "繼任人選",
      keyPositionId: row.keyPositionId,
      keyPositionTitle: row.title,
      title: row.title,
      department: row.department,
      riskLevel: row.riskLevel,
      readiness: row.readiness,
      readinessLabel: READINESS_LABELS[row.readiness] ?? row.readiness,
      notes: row.notes,
    })),
  ];

  return json({ employee, responsibilities, totalCount: responsibilities.length });
}

// ---------------------------------------------------------------------------
// 離職連動
// ---------------------------------------------------------------------------

/**
 * 員工標記離職時停用其登入帳號並刪除 sessions（由 m1.ts updateEmployee 呼叫）。
 *
 * 只單向停用：復職（status 改回 active）刻意不自動啟用帳號，
 * 必須由 admin 明確 PATCH /api/admin/users/{id} active=true，
 * 避免「改個資料就把離職者的存取權還回去」這種非預期授權。
 *
 * 回傳實際被停用的帳號數（原本就停用的不計）。刻意先 SELECT 出目標再更新，
 * 不用 UPDATE 的 meta.changes 當筆數：users 有 AFTER UPDATE 觸發器
 * （migrations/0002_indexes.sql:21 users_updated_at），觸發器內的 UPDATE 也會被計進
 * changes，實測一列會回報 2。
 */
export async function deactivateAccountsForEmployee(
  db: D1Database,
  employeeId: string,
): Promise<number> {
  const targets = await db.prepare(
    "SELECT id FROM users WHERE employee_id = ? AND active = 1",
  ).bind(employeeId).all<{ id: string }>();
  if (targets.results.length === 0) return 0;
  await db.batch(targets.results.flatMap(({ id }) => [
    db.prepare("UPDATE users SET active = 0 WHERE id = ?").bind(id),
    deleteSessions(db, id),
  ]));
  return targets.results.length;
}

export async function handleAdminAccounts(context: ApiContext, path: string): Promise<Response | null> {
  const admin = requireAdmin(context.user);
  const method = context.request.method;

  if (path === "/api/admin/users" && method === "GET") return listAccounts(context);
  if (path === "/api/admin/users" && method === "POST") return createAccount(context, admin);

  const resetMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/reset-password$/);
  if (resetMatch?.[1] && method === "POST") return resetPassword(context, admin, resetMatch[1]);

  const userMatch = path.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (userMatch?.[1] && method === "PATCH") return updateAccount(context, admin, userMatch[1]);
  if (userMatch?.[1] && method === "DELETE") return deleteAccount(context, admin, userMatch[1]);

  const responsibilitiesMatch = path.match(/^\/api\/admin\/employees\/([^/]+)\/responsibilities$/);
  if (responsibilitiesMatch?.[1] && method === "GET") {
    return employeeResponsibilities(context, responsibilitiesMatch[1]);
  }
  return null;
}
