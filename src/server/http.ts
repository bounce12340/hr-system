import type { AuthUser } from "./types";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(
    { ok: status < 400, data: status < 400 ? data : undefined, error: status >= 400 ? data : undefined },
    { status, headers },
  );
}

export function errorResponse(error: unknown, request: Request): Response {
  if (error instanceof ApiError) {
    return json(
      { message: error.message, details: error.details },
      error.status,
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({
    message: "Unhandled API error",
    error: message,
    method: request.method,
    path: new URL(request.url).pathname,
  }));
  return json({ message: "系統暫時無法處理此要求，請稍後再試。" }, 500);
}

export async function parseJson<T extends object>(request: Request): Promise<T> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "請使用 application/json 格式送出資料。");
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 1_000_000) {
    throw new ApiError(413, "送出的資料超過 1 MB 限制。");
  }

  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as T;
  } catch {
    throw new ApiError(400, "JSON 格式不正確。");
  }
}

export function assertTrustedMutation(request: Request): void {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
    return;
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new ApiError(403, "跨來源操作已被拒絕。");
  }
}

export function requireUser(user: AuthUser | null): AuthUser {
  if (!user) {
    throw new ApiError(401, "請先登入。");
  }
  return user;
}

export function requireAdmin(user: AuthUser | null): AuthUser {
  const current = requireUser(user);
  if (current.mustChangePassword) {
    throw new ApiError(428, "首次登入請先變更密碼。");
  }
  if (current.role !== "admin") {
    throw new ApiError(403, "您沒有執行此操作的權限。");
  }
  return current;
}

export function requireEmployeeIdentity(user: AuthUser | null): AuthUser & { employeeId: string } {
  const current = requireUser(user);
  if (current.mustChangePassword) {
    throw new ApiError(428, "首次登入請先變更密碼。");
  }
  if (!current.employeeId) {
    throw new ApiError(403, "此帳號未連結員工資料。");
  }
  return current as AuthUser & { employeeId: string };
}

export function requiredString(value: unknown, label: string, maxLength = 500): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError(422, `${label}為必填。`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new ApiError(422, `${label}不可超過 ${maxLength} 字。`);
  }
  return normalized;
}

export function optionalString(value: unknown, label: string, maxLength = 2000): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new ApiError(422, `${label}格式不正確。`);
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new ApiError(422, `${label}不可超過 ${maxLength} 字。`);
  }
  return normalized;
}

export function uuid(): string {
  return crypto.randomUUID();
}
