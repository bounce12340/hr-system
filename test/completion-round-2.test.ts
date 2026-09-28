import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

interface Envelope<T> { ok: boolean; data?: T; error?: { message: string }; }
async function call<T>(path: string, init?: RequestInit) {
  const response = await exports.default.fetch(`https://example.com${path}`, init);
  return { response, body: await response.json<Envelope<T>>() };
}
let adminCookie = "";
let employeeCookie = "";
function request(method: string, cookie: string, body?: object): RequestInit {
  return { method, headers: { "Content-Type": "application/json", Cookie: cookie }, ...(body ? { body: JSON.stringify(body) } : {}) };
}
async function login(email: string): Promise<string> {
  await env.DB.prepare("UPDATE users SET must_change_password = 0 WHERE email = ?").bind(email).run();
  const result = await call("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "Demo1234!" }) });
  expect(result.response.status).toBe(200);
  return result.response.headers.get("set-cookie")?.split(";")[0] ?? "";
}
async function hiredApplication(label: string): Promise<{ applicationId: string; jobTypeId: string }> {
  const opening = await call<{ id: string }>("/api/admin/recruitment/job-openings", request("POST", adminCookie, { title: `到職轉換 ${label}`, department: "測試部", headcount: 1, description: "第二輪到職轉換回歸測試。", status: "open" }));
  const candidate = await call<{ id: string }>("/api/admin/recruitment/candidates", request("POST", adminCookie, { name: `候選人 ${label}`, email: `round2-${crypto.randomUUID()}@example.com`, phone: "", source: "Vitest", resumeUrl: "", notes: "" }));
  const application = await call<{ id: string }>(`/api/admin/recruitment/candidates/${candidate.body.data?.id}/applications`, request("POST", adminCookie, { jobOpeningId: opening.body.data?.id }));
  const applicationId = application.body.data?.id ?? "";
  for (const status of ["screening", "interview", "salary_approval", "offer", "hired"]) {
    if (status === "salary_approval") {
      const candidateId = await env.DB.prepare("SELECT candidate_id AS candidateId FROM candidate_applications WHERE id = ?")
        .bind(applicationId).first<{ candidateId: string }>();
      const interviewId = `int-${crypto.randomUUID()}`;
      await env.DB.prepare(`INSERT INTO interviews(id,candidate_id,round_number,scheduled_at,interviewer_name,location,status,application_id,notes) VALUES(?, ?, 1, '2026-01-01T00:00:00.000Z', '測試主管', '測試', 'completed', ?, '')`).bind(interviewId, candidateId?.candidateId, applicationId).run();
      await env.DB.prepare("INSERT INTO interview_scores(id,interview_id,dimension,score,comments) VALUES(?, ?, '能力', 5, '')").bind(`score-${crypto.randomUUID()}`, interviewId).run();
    }
    if (status === "offer") await env.DB.prepare("INSERT INTO salary_approvals(id,application_id,approved_salary,status) VALUES(?, ?, 70000, 'approved')").bind(`salary-${crypto.randomUUID()}`, applicationId).run();
    if (status === "hired") await env.DB.prepare("INSERT INTO recruitment_offers(id,application_id,status,notice_text) VALUES(?, ?, 'accepted', '')").bind(`offer-${crypto.randomUUID()}`, applicationId).run();
    expect((await call(`/api/admin/recruitment/applications/${applicationId}/transition`, request("POST", adminCookie, { status, note: "第二輪測試" }))).response.status).toBe(200);
  }
  const jobType = await env.DB.prepare("SELECT id FROM job_types WHERE active = 1 LIMIT 1").first<{ id: string }>();
  return { applicationId, jobTypeId: jobType?.id ?? "" };
}
function conversionBody(jobTypeId: string, email: string, suffix: string, overrides: object = {}) {
  return { employeeNo: `R2-${suffix}-${crypto.randomUUID().slice(0, 8)}`, email, department: "測試部", grade: "G1", title: "測試職務", jobTypeId, hireDate: "2026-09-28", salary: null, confirmed: true, ...overrides };
}
beforeAll(async () => { adminCookie = await login("admin@demo.local"); employeeCookie = await login("chiahao.lin@demo.local"); });

describe("第二輪到職轉換安全回歸", () => {
  it("只讓管理員以顯式確認的已錄取且文件完成申請建立一位員工、歷程與審計", async () => {
    const { applicationId, jobTypeId } = await hiredApplication("成功");
    const candidate = await env.DB.prepare(`SELECT c.email FROM candidates c JOIN candidate_applications ca ON ca.candidate_id=c.id WHERE ca.id=?`).bind(applicationId).first<{ email: string }>();
    const checklist = await call<{ items: Array<{ itemId: string; required: number }> }>(`/api/admin/recruitment/applications/${applicationId}/onboarding-checklist`, { headers: { Cookie: adminCookie } });
    for (const item of checklist.body.data?.items.filter((item) => item.required === 1) ?? []) expect((await call(`/api/admin/recruitment/applications/${applicationId}/onboarding-checklist/${item.itemId}`, request("PUT", adminCookie, { completed: true, notes: "" }))).response.status).toBe(200);
    const body = conversionBody(jobTypeId, candidate?.email ?? "", "success");
    const concurrent = await Promise.all([
      call<{ employeeId: string; alreadyConverted: boolean }>(`/api/admin/recruitment/applications/${applicationId}/convert-employee`, request("POST", adminCookie, body)),
      call<{ employeeId: string; alreadyConverted: boolean }>(`/api/admin/recruitment/applications/${applicationId}/convert-employee`, request("POST", adminCookie, body)),
    ]);
    expect(concurrent.map((result) => result.response.status).sort()).toEqual([200, 201]);
    const converted = concurrent.find((result) => result.response.status === 201) ?? concurrent[0];
    expect(converted.body.data?.alreadyConverted).toBe(false);
    expect(await env.DB.prepare("SELECT status FROM candidate_applications WHERE id=?").bind(applicationId).first()).toMatchObject({ status: "onboarded" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM recruitment_employee_conversions WHERE application_id=?").bind(applicationId).first()).toMatchObject({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE entity_id=? AND action='onboarding.convert'").bind(applicationId).first()).toMatchObject({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE employee_id=?").bind(converted.body.data?.employeeId).first()).toMatchObject({ n: 0 });
    const repeat = await call<{ employeeId: string; alreadyConverted: boolean }>(`/api/admin/recruitment/applications/${applicationId}/convert-employee`, request("POST", adminCookie, body));
    const conflicting = await call(`/api/admin/recruitment/applications/${applicationId}/convert-employee`, request("POST", adminCookie, { ...body, salary: 1 }));
    expect(conflicting.response.status).toBe(409);
  });
  it("拒絕未到職文件、缺少確認與跨角色，且不建立員工", async () => {
    const { applicationId, jobTypeId } = await hiredApplication("拒絕");
    const candidate = await env.DB.prepare(`SELECT c.email FROM candidates c JOIN candidate_applications ca ON ca.candidate_id=c.id WHERE ca.id=?`).bind(applicationId).first<{ email: string }>();
    const body = conversionBody(jobTypeId, candidate?.email ?? "", "deny");
    expect((await call(`/api/admin/recruitment/applications/${applicationId}/convert-employee`, request("POST", adminCookie, { ...body, confirmed: false }))).response.status).toBe(422);
    expect((await call(`/api/admin/recruitment/applications/${applicationId}/convert-employee`, request("POST", employeeCookie, body))).response.status).toBe(403);
    expect((await call(`/api/admin/recruitment/applications/${applicationId}/convert-employee`, request("POST", adminCookie, body))).response.status).toBe(409);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM recruitment_employee_conversions WHERE application_id=?").bind(applicationId).first()).toMatchObject({ n: 0 });
  });
});
describe("第二輪通知安全閘門", () => {
  it("僅管理員可取得不含個資的乾跑摘要；沒有派送或 outbox 寫入", async () => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox").first<{ n: number }>();
    const config = await call<{ enabled: boolean; deliveryAvailable: boolean; policyPending: boolean }>("/api/admin/reminder-notifications/config", { headers: { Cookie: adminCookie } });
    expect(config.response.status).toBe(200);
    expect(config.body.data).toMatchObject({ enabled: false, deliveryAvailable: false, policyPending: true });
    const dry = await call<{ dryRun: boolean; queued: boolean; preview: string }>("/api/admin/reminder-notifications/run", request("POST", adminCookie, { dryRun: true }));
    expect(dry.response.status).toBe(200);
    expect(dry.body.data).toMatchObject({ dryRun: true, queued: false });
    expect(dry.body.data?.preview).not.toMatch(/薪資|健檢結果|診斷|@/);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox").first()).toEqual(before);
    expect((await call("/api/admin/reminder-notifications/run", request("POST", adminCookie, { dryRun: false }))).response.status).toBe(409);
    expect((await call("/api/admin/reminder-notifications/config", { headers: { Cookie: employeeCookie } })).response.status).toBe(403);
  });
});
