import { handleAdminAccounts } from "./accounts";
import { authenticate, changePassword, completeTour, login, logout } from "./auth";
import { handleAdminHealthCheck, handleEmployeeHealthCheck } from "./health";
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
import { handlePublicPasswordSetup } from "./password-setup";
import { handleAdminSettings } from "./settings";
import { turnstileSiteKey } from "./turnstile";
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
    // 登入頁在還沒有人登入時就需要知道要不要顯示人機驗證框，所以這支必須公開。
    // 只回 site key——它本來就會出現在 HTML 裡，不是機密（見 turnstile.ts）。
    // 之所以用 API 取得而不是在 build 時打進前端：build 時忘了帶環境變數，
    // 會變成前端沒有驗證框、後端卻要求 token，全站登不進去；改由同一個 Worker
    // 的 env 供應，兩邊必定同步。
    if (path === "/api/public-config" && request.method === "GET") {
      return json({ turnstileSiteKey: turnstileSiteKey(env) });
    }
    if (path === "/api/auth/login" && request.method === "POST") {
      const result = await login(request, env);
      return json({ user: result.user }, 200, { "Set-Cookie": result.cookie });
    }
    // 密碼設定連結與忘記密碼是公開端點，必須擺在 authenticate 之前：
    // 會用到它們的人正是還沒有密碼、登不進來的人。放在這裡也順便省掉一次
    // 不可能命中的 session 查詢。
    const publicSetupResponse = await handlePublicPasswordSetup(request, env, path);
    if (publicSetupResponse) return publicSetupResponse;

    const user = await authenticate(request, env.DB);
    const context: ApiContext = { request, env, url, user };

    if (path === "/api/auth/me" && request.method === "GET") {
      return json({ user: requireUser(user) });
    }
    if (path === "/api/auth/change-password" && request.method === "POST") {
      return json({ user: await changePassword(request, env.DB, requireUser(user)) });
    }
    if (path === "/api/auth/tour-complete" && request.method === "POST") {
      // 任何登入者都能呼叫，包含 mustChangePassword 尚未處理的人——導覽與權限
      // 無關，用 requireUser 而非 requireAdmin／requireEmployeeIdentity。
      return json({ user: await completeTour(env.DB, requireUser(user)) });
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
      const healthResponse = await handleAdminHealthCheck(context, path);
      if (healthResponse) return healthResponse;
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
      const healthResponse = await handleEmployeeHealthCheck(context, path);
      if (healthResponse) return healthResponse;
    }

    throw new ApiError(404, "找不到此 API。");
  } catch (error) {
    return errorResponse(error, request);
  }
}
