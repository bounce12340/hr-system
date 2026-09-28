import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { message: string };
}

async function call<T>(path: string, init?: RequestInit) {
  const response = await exports.default.fetch(`https://example.com${path}`, init);
  return { response, body: await response.json<Envelope<T>>() };
}

let adminCookie = "";

async function adminRequest<T>(path: string, method: string, data?: object) {
  return call<T>(path, {
    method,
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
}

async function makeApplication(label: string): Promise<string> {
  const opening = await adminRequest<{ id: string }>("/api/admin/recruitment/job-openings", "POST", {
    title: `歷程一致性 ${label}`,
    department: "測試部",
    headcount: 1,
    description: "招募狀態歷程一致性回歸測試使用。",
    status: "open",
  });
  expect(opening.response.status).toBe(201);
  const candidate = await adminRequest<{ id: string }>("/api/admin/recruitment/candidates", "POST", {
    name: `一致性測試 ${label}`,
    email: `recruitment-consistency-${crypto.randomUUID()}@example.com`,
    phone: "",
    source: "Vitest",
    resumeUrl: "",
    notes: "",
  });
  expect(candidate.response.status).toBe(201);
  const application = await adminRequest<{ id: string }>(
    `/api/admin/recruitment/candidates/${candidate.body.data?.id}/applications`,
    "POST",
    { jobOpeningId: opening.body.data?.id },
  );
  expect(application.response.status).toBe(201);
  return application.body.data?.id ?? "";
}

async function historyCount(applicationId: string): Promise<number> {
  const result = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM candidate_application_status_history WHERE application_id = ?",
  ).bind(applicationId).first<{ count: number }>();
  return result?.count ?? 0;
}

beforeAll(async () => {
  await env.DB.prepare("UPDATE users SET must_change_password = 0 WHERE email = 'admin@demo.local'").run();
  const login = await call("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@demo.local", password: "Demo1234!" }),
  });
  expect(login.response.status).toBe(200);
  adminCookie = login.response.headers.get("set-cookie")?.split(";")[0] ?? "";
});

describe("招募狀態與歷程原子一致性", () => {
  it("成功轉換時恰好增加一筆相符歷程", async () => {
    const id = await makeApplication("成功");
    expect(await historyCount(id)).toBe(1);

    const transition = await adminRequest(`/api/admin/recruitment/applications/${id}/transition`, "POST", {
      status: "screening",
      note: "回歸測試",
    });

    expect(transition.response.status).toBe(200);
    expect(await env.DB.prepare("SELECT status FROM candidate_applications WHERE id = ?")
      .bind(id).first<{ status: string }>()).toMatchObject({ status: "screening" });
    expect(await historyCount(id)).toBe(2);
    expect(await env.DB.prepare(`
      SELECT from_status AS fromStatus, to_status AS toStatus
      FROM candidate_application_status_history
      WHERE application_id = ? ORDER BY changed_at DESC, rowid DESC LIMIT 1
    `).bind(id).first()).toMatchObject({ fromStatus: "applied", toStatus: "screening" });
  });

  it("同一舊狀態的併發轉換最多只提交一個且不留下假歷程", async () => {
    const id = await makeApplication("並行");
    expect(await historyCount(id)).toBe(1);
    const path = `/api/admin/recruitment/applications/${id}/transition`;
    // 同時送出兩個都以 applied 為前置狀態的合法更新，讓 D1 的原子
    // batch 決定唯一勝者；失敗者必須回 409，歷程只增加勝者的一筆。
    const responses = await Promise.all([
      adminRequest(path, "POST", { status: "screening", note: "競爭者一" }),
      adminRequest(path, "POST", { status: "screening", note: "競爭者二" }),
    ]);
    expect(responses.map(({ response }) => response.status).sort()).toEqual([200, 409]);
    expect(await env.DB.prepare("SELECT status FROM candidate_applications WHERE id = ?")
      .bind(id).first<{ status: string }>()).toMatchObject({ status: "screening" });
    expect(await historyCount(id)).toBe(2);
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM candidate_application_status_history
      WHERE application_id = ? AND from_status = 'applied' AND to_status = 'screening'
    `).bind(id).first<{ count: number }>()).toMatchObject({ count: 1 });
  });
});
