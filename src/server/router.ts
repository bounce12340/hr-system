import { handleAdminAccounts } from "./accounts";
import { authenticate, changePassword, login, logout } from "./auth";
import {
  ApiError,
  assertTrustedMutation,
  errorResponse,
  json,
  requireAdmin,
  requireUser,
} from "./http";
import { handleAdminM1, handleEmployeeM1 } from "./m1";
import { handleAdminM2, handleEmployeeM2 } from "./m2";
import { handleAdminM3 } from "./m3";
import { handleAdminM4 } from "./m4";
import { handleAdminM5, handleEmployeeM5 } from "./m5";
import { handleAdminSettings } from "./settings";
import type { ApiContext } from "./types";

function corsPreflight(request: Request): Response {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new ApiError(403, "跨來源要求已被拒絕。");
  }
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  try {
    if (request.method === "OPTIONS") return corsPreflight(request);
    assertTrustedMutation(request);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/api/health" && request.method === "GET") {
      return json({ status: "ok", timezone: "Asia/Taipei" });
    }
    if (path === "/api/auth/login" && request.method === "POST") {
      const result = await login(request, env.DB);
      return json({ user: result.user }, 200, { "Set-Cookie": result.cookie });
    }

    const user = await authenticate(request, env.DB);
    const context: ApiContext = { request, env, url, user };

    if (path === "/api/auth/me" && request.method === "GET") {
      return json({ user: requireUser(user) });
    }
    if (path === "/api/auth/change-password" && request.method === "POST") {
      return json({ user: await changePassword(request, env.DB, requireUser(user)) });
    }
    if (path === "/api/auth/logout" && request.method === "POST") {
      return json({}, 200, { "Set-Cookie": await logout(request, env.DB) });
    }
    if (path.startsWith("/api/admin/")) {
      requireAdmin(user);
      // 帳號管理放最前面：/api/admin/users 與 /api/admin/employees/{id}/responsibilities
      // 都不與其他模組的路徑重疊，先比對可省掉後面五個模組的 match。
      const accountsResponse = await handleAdminAccounts(context, path);
      if (accountsResponse) return accountsResponse;
      const response = await handleAdminM1(context, path);
      if (response) return response;
      const m2Response = await handleAdminM2(context, path);
      if (m2Response) return m2Response;
      const m3Response = await handleAdminM3(context, path);
      if (m3Response) return m3Response;
      const m4Response = await handleAdminM4(context, path);
      if (m4Response) return m4Response;
      const m5Response = await handleAdminM5(context, path);
      if (m5Response) return m5Response;
      const settingsResponse = await handleAdminSettings(context, path);
      if (settingsResponse) return settingsResponse;
    }
    if (path.startsWith("/api/employee/")) {
      const response = await handleEmployeeM1(context, path);
      if (response) return response;
      const m2Response = await handleEmployeeM2(context, path);
      if (m2Response) return m2Response;
      const m5Response = await handleEmployeeM5(context, path);
      if (m5Response) return m5Response;
    }

    throw new ApiError(404, "找不到此 API。");
  } catch (error) {
    return errorResponse(error, request);
  }
}
