import { ApiError, parseJson, requiredString, uuid } from "./http";
import type { AuthUser } from "./types";

const SESSION_COOKIE = "hr_session";
const SESSION_SECONDS = 60 * 60 * 12;
const PASSWORD_ITERATIONS = 100_000;

interface UserRow {
  id: string;
  employee_id: string | null;
  email: string;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
  role: "admin" | "employee";
  must_change_password: number;
  employee_name: string | null;
  department: string | null;
}

interface LoginBody {
  email?: unknown;
  password?: unknown;
}

interface ChangePasswordBody {
  currentPassword?: unknown;
  newPassword?: unknown;
}

function toBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function derivePassword(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const result = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    256,
  );
  return new Uint8Array(result);
}

async function secureEqual(first: Uint8Array, second: Uint8Array): Promise<boolean> {
  const [firstHash, secondHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", first),
    crypto.subtle.digest("SHA-256", second),
  ]);
  return crypto.subtle.timingSafeEqual(firstHash, secondHash);
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseCookies(request: Request): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0) {
      cookies.set(part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim()));
    }
  }
  return cookies;
}

function publicUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    employeeId: row.employee_id,
    email: row.email,
    role: row.role,
    mustChangePassword: row.must_change_password === 1,
    employeeName: row.employee_name,
    department: row.department,
  };
}

async function loadUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare(`
    SELECT u.id, u.employee_id, u.email, u.password_hash, u.password_salt,
           u.password_iterations, u.role, u.must_change_password,
           e.name AS employee_name, e.department
    FROM users u
    LEFT JOIN employees e ON e.id = u.employee_id
    WHERE u.email = ? COLLATE NOCASE AND u.active = 1
  `).bind(email).first<UserRow>();
}

export async function authenticate(request: Request, db: D1Database): Promise<AuthUser | null> {
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await hashToken(token);
  const row = await db.prepare(`
    SELECT u.id, u.employee_id, u.email, u.password_hash, u.password_salt,
           u.password_iterations, u.role, u.must_change_password,
           e.name AS employee_name, e.department
    FROM sessions s
    JOIN users u ON u.id = s.user_id AND u.active = 1
    LEFT JOIN employees e ON e.id = u.employee_id
    WHERE s.token_hash = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).bind(tokenHash).first<UserRow>();
  return row ? publicUser(row) : null;
}

export async function login(request: Request, db: D1Database): Promise<{ user: AuthUser; cookie: string }> {
  const body = await parseJson<LoginBody>(request);
  const email = requiredString(body.email, "電子郵件", 200).toLowerCase();
  const password = requiredString(body.password, "密碼", 200);
  const row = await loadUserByEmail(db, email);

  if (!row) {
    throw new ApiError(401, "電子郵件或密碼錯誤。");
  }
  const actual = await derivePassword(password, toBytes(row.password_salt), row.password_iterations);
  const valid = await secureEqual(actual, toBytes(row.password_hash));
  if (!valid) {
    throw new ApiError(401, "電子郵件或密碼錯誤。");
  }

  const token = randomToken();
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
  await db.prepare(`
    INSERT INTO sessions (id, user_id, token_hash, expires_at, user_agent, ip_address)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    uuid(),
    row.id,
    tokenHash,
    expiresAt,
    request.headers.get("user-agent"),
    request.headers.get("cf-connecting-ip"),
  ).run();

  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return {
    user: publicUser(row),
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=${SESSION_SECONDS}`,
  };
}

export async function logout(request: Request, db: D1Database): Promise<string> {
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (token) {
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await hashToken(token)).run();
  }
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

function assertPasswordStrength(password: string): void {
  if (
    password.length < 10 ||
    !/[a-z]/.test(password) ||
    !/[A-Z]/.test(password) ||
    !/\d/.test(password) ||
    !/[^A-Za-z0-9]/.test(password)
  ) {
    throw new ApiError(422, "新密碼至少 10 碼，且須包含大小寫英文字母、數字與符號。");
  }
}

export async function changePassword(
  request: Request,
  db: D1Database,
  user: AuthUser,
): Promise<AuthUser> {
  const body = await parseJson<ChangePasswordBody>(request);
  const currentPassword = requiredString(body.currentPassword, "目前密碼", 200);
  const newPassword = requiredString(body.newPassword, "新密碼", 200);
  assertPasswordStrength(newPassword);
  if (currentPassword === newPassword) {
    throw new ApiError(422, "新密碼不可與目前密碼相同。");
  }

  const row = await loadUserByEmail(db, user.email);
  if (!row) throw new ApiError(401, "帳號已停用。");
  const actual = await derivePassword(currentPassword, toBytes(row.password_salt), row.password_iterations);
  if (!(await secureEqual(actual, toBytes(row.password_hash)))) {
    throw new ApiError(401, "目前密碼錯誤。");
  }

  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const newHash = await derivePassword(newPassword, salt, PASSWORD_ITERATIONS);
  await db.batch([
    db.prepare(`
      UPDATE users
      SET password_hash = ?, password_salt = ?, password_iterations = ?, must_change_password = 0
      WHERE id = ?
    `).bind(toBase64(newHash), toBase64(salt), PASSWORD_ITERATIONS, user.id),
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?").bind(
      user.id,
      await hashToken(parseCookies(request).get(SESSION_COOKIE) ?? ""),
    ),
  ]);

  return { ...user, mustChangePassword: false };
}

interface CreateUserBody {
  employeeId?: unknown;
  email?: unknown;
  temporaryPassword?: unknown;
  role?: unknown;
}

export async function createUser(request: Request, db: D1Database): Promise<{ id: string; email: string }> {
  const body = await parseJson<CreateUserBody>(request);
  const employeeId = requiredString(body.employeeId, "員工", 100);
  const email = requiredString(body.email, "電子郵件", 200).toLowerCase();
  const temporaryPassword = requiredString(body.temporaryPassword, "暫時密碼", 200);
  const role = body.role === "admin" ? "admin" : body.role === "employee" ? "employee" : null;
  if (!role) throw new ApiError(422, "角色必須是 admin 或 employee。");
  assertPasswordStrength(temporaryPassword);

  const employee = await db.prepare("SELECT id FROM employees WHERE id = ?").bind(employeeId).first();
  if (!employee) throw new ApiError(404, "找不到指定員工。");
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await derivePassword(temporaryPassword, salt, PASSWORD_ITERATIONS);
  const id = uuid();
  try {
    await db.prepare(`
      INSERT INTO users (id, employee_id, email, password_hash, password_salt, password_iterations, role, must_change_password)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(id, employeeId, email, toBase64(hash), toBase64(salt), PASSWORD_ITERATIONS, role).run();
  } catch {
    throw new ApiError(409, "此員工或電子郵件已有帳號。");
  }
  return { id, email };
}
