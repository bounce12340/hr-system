import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { message: string };
}

async function api<T>(path: string, init?: RequestInit): Promise<{ response: Response; body: Envelope<T> }> {
  const response = await exports.default.fetch(`https://example.com${path}`, init);
  return { response, body: await response.json<Envelope<T>>() };
}

async function login(email: string): Promise<string> {
  const { response } = await api<{ user: { role: string } }>("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Demo1234!" }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Strict");
  return cookie?.split(";")[0] ?? "";
}

describe("Auth 與角色權限", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM sessions").run();
  });

  it("可用 PBKDF2 種子帳號登入並讀取自己的身分", async () => {
    const cookie = await login("admin@demo.local");
    const { response, body } = await api<{ user: { email: string; role: string; mustChangePassword: boolean } }>(
      "/api/auth/me",
      { headers: { Cookie: cookie } },
    );
    expect(response.status).toBe(200);
    expect(body.data?.user).toMatchObject({
      email: "admin@demo.local",
      role: "admin",
      mustChangePassword: true,
    });
  });

  it("首次登入強制改密碼，employee 改密碼後仍不可呼叫 admin API", async () => {
    const cookie = await login("chiahao.lin@demo.local");
    const blocked = await api("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({}),
    });
    expect(blocked.response.status).toBe(428);

    const changed = await api<{ user: { mustChangePassword: boolean } }>("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ currentPassword: "Demo1234!", newPassword: "Changed1234!" }),
    });
    expect(changed.response.status).toBe(200);
    expect(changed.body.data?.user.mustChangePassword).toBe(false);

    const forbidden = await api("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({}),
    });
    expect(forbidden.response.status).toBe(403);
  });

  it("拒絕跨來源 mutation", async () => {
    const response = await exports.default.fetch("https://example.com/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
      },
      body: JSON.stringify({ email: "admin@demo.local", password: "Demo1234!" }),
    });
    expect(response.status).toBe(403);
  });
});
