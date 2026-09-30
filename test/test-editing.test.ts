import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

let cookie = "";
async function call(path: string, init?: RequestInit) {
  const response = await exports.default.fetch(`https://example.com${path}`, init);
  return { response, body: await response.json<{ data?: Record<string, unknown>; error?: { message: string } }>() };
}
const json = (method: string, body: object): RequestInit => ({
  method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body),
});
async function authenticate() {
  const login = await call("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@demo.local", password: "Demo1234!" }) });
  expect(login.response.status).toBe(200);
  const value = login.response.headers.get("set-cookie")?.split(";")[0] ?? "";
  const changed = await call("/api/auth/change-password", { method: "POST", headers: { "Content-Type": "application/json", Cookie: value }, body: JSON.stringify({ currentPassword: "Demo1234!", newPassword: "AdminEditTest1234!" }) });
  expect(changed.response.status).toBe(200);
  return value;
}
beforeAll(async () => { cookie = await authenticate(); });

describe("M2 測驗編輯 D1 API", () => {
  it("換場次在有分數時回 409，無分數可移動；PATCH 門檻重算狀態", async () => {
    const id = `test-edit-${crypto.randomUUID()}`;
    const created = await call("/api/admin/tests", json("POST", { courseSessionId: "cs-01", name: "編輯驗證", passingScore: 70 }));
    expect(created.response.status).toBe(201);
    const testId = String(created.body.data?.id ?? "");
    const scored = await call(`/api/admin/tests/${testId}/results`, json("PUT", { records: [{ employeeId: "emp-002", score: 80 }] }));
    expect(scored.response.status).toBe(200);
    const rejected = await call(`/api/admin/tests/${testId}`, json("PATCH", { courseSessionId: "cs-02", name: "不能移場", passingScore: 85 }));
    expect(rejected.response.status).toBe(409);
    const threshold = await call(`/api/admin/tests/${testId}`, json("PATCH", { courseSessionId: "cs-01", name: "修訂名稱", passingScore: 85 }));
    expect(threshold.response.status).toBe(200);
    const failed = await env.DB.prepare("SELECT passed, retraining_required AS retrainingRequired FROM test_results WHERE test_id = ? AND employee_id = 'emp-002'").bind(testId).first<{ passed: number; retrainingRequired: number }>();
    expect(failed).toEqual({ passed: 0, retrainingRequired: 1 });
    const passed = await call(`/api/admin/tests/${testId}`, json("PATCH", { courseSessionId: "cs-01", name: "再修訂", passingScore: 75 }));
    expect(passed.response.status).toBe(200);
    const restored = await env.DB.prepare("SELECT passed, retraining_required AS retrainingRequired FROM test_results WHERE test_id = ? AND employee_id = 'emp-002'").bind(testId).first<{ passed: number; retrainingRequired: number }>();
    expect(restored).toEqual({ passed: 1, retrainingRequired: 0 });
    await call(`/api/admin/tests/${testId}`, { method: "DELETE", headers: { Cookie: cookie } });

    const empty = await call("/api/admin/tests", json("POST", { courseSessionId: "cs-01", name: id, passingScore: 70 }));
    const emptyId = String(empty.body.data?.id ?? "");
    const moved = await call(`/api/admin/tests/${emptyId}`, json("PATCH", { courseSessionId: "cs-02", name: "移動成功", passingScore: 70 }));
    expect(moved.response.status).toBe(200);
    await call(`/api/admin/tests/${emptyId}`, { method: "DELETE", headers: { Cookie: cookie } });
  });
});
