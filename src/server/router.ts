import { authenticate, changePassword, createUser, login, logout } from "./auth";
import {
  ApiError,
  assertTrustedMutation,
  errorResponse,
  json,
  requireAdmin,
  requireUser,
} from "./http";
import { handleAdminM1, handleEmployeeM1 } from "./m1";
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
    if (path === "/api/admin/users" && request.method === "POST") {
      requireAdmin(user);
      return json(await createUser(request, env.DB), 201);
    }

    if (path.startsWith("/api/admin/")) {
      requireAdmin(user);
      const response = await handleAdminM1(context, path);
      if (response) return response;
    }
    if (path.startsWith("/api/employee/")) {
      const response = await handleEmployeeM1(context, path);
      if (response) return response;
    }

    throw new ApiError(404, "找不到此 API。");
  } catch (error) {
    return errorResponse(error, request);
  }
}
