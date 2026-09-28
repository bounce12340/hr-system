import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { handleApi } from "../src/server/router";

let cookie = "";
beforeAll(async () => {
  await env.DB.prepare("UPDATE users SET must_change_password = 0 WHERE email = 'admin@demo.local'").run();
  const response = await exports.default.fetch("https://example.com/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@demo.local", password: "Demo1234!" }),
  });
  expect(response.status).toBe(200);
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
});

// Inject an actual D1 write after the handler's reads but before its atomic batch.
// This is a deterministic stale-read test, not a mock of SQL results.
async function withConcurrentWrite(path: string, method: string, body: object, write: () => Promise<unknown>) {
  let injected = false;
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        if (!injected) { injected = true; await write(); }
        return target.batch(statements);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const response = await handleApi(new Request(`https://example.com${path}`, {
    method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body),
  }), { ...env, DB: db });
  expect(injected).toBe(true);
  return response;
}

describe("D1 確定性 stale-read 回歸", () => {
  it("狀態被搶先更改時回409而不追加假歷程", async () => {
    const row = await env.DB.prepare("SELECT id FROM candidate_applications WHERE status = 'applied' LIMIT 1").first<{ id: string }>();
    expect(row).not.toBeNull();
    const id = row!.id;
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM candidate_application_status_history WHERE application_id = ?").bind(id).first<{ n: number }>();
    const response = await withConcurrentWrite(`/api/admin/recruitment/applications/${id}/transition`, "POST", { status: "screening" },
      () => env.DB.prepare("UPDATE candidate_applications SET status = 'rejected' WHERE id = ?").bind(id).run());
    expect(response.status).toBe(409);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM candidate_application_status_history WHERE application_id = ?").bind(id).first()).toEqual(before);
    expect(await env.DB.prepare("SELECT status FROM candidate_applications WHERE id = ?").bind(id).first()).toEqual({ status: "rejected" });
  });

  it("登錄分數時以寫入當下的門檻判分", async () => {
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO tests (id, course_session_id, name, passing_score) VALUES (?, 'cs-01', '門檻競爭', 70)").bind(id).run();
    const response = await withConcurrentWrite(`/api/admin/tests/${id}/results`, "PUT", { records: [{ employeeId: "emp-002", score: 80 }] },
      () => env.DB.prepare("UPDATE tests SET passing_score = 90 WHERE id = ?").bind(id).run());
    expect(response.status).toBe(200);
    expect(await env.DB.prepare("SELECT passed, retraining_required FROM test_results WHERE test_id = ?").bind(id).first()).toEqual({ passed: 0, retraining_required: 1 });
  });

  it("驗證名單後場次被更改時整批不寫入成績", async () => {
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO tests (id, course_session_id, name, passing_score) VALUES (?, 'cs-01', '場次競爭', 70)").bind(id).run();
    const response = await withConcurrentWrite(`/api/admin/tests/${id}/results`, "PUT", { records: [{ employeeId: "emp-002", score: 80 }] },
      () => env.DB.prepare("UPDATE tests SET course_session_id = 'cs-02' WHERE id = ?").bind(id).run());
    expect(response.status).toBe(409);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM test_results WHERE test_id = ?").bind(id).first()).toEqual({ n: 0 });
  });
});
