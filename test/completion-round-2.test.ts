import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { handleApi } from "../src/server/router";
import { strictIsoDate } from "../src/server/onboarding-conversion";

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
async function hiredApplication(label: string): Promise<{ applicationId: string; jobTypeId: string; email: string }> {
  const opening = await call<{ id: string }>("/api/admin/recruitment/job-openings", request("POST", adminCookie, { title: `到職轉換 ${label}`, department: "測試部", headcount: 1, description: "第二輪到職轉換回歸測試。", status: "open" }));
  const email = `round2-${crypto.randomUUID()}@example.com`;
  const candidate = await call<{ id: string }>("/api/admin/recruitment/candidates", request("POST", adminCookie, { name: `候選人 ${label}`, email, phone: "", source: "Vitest", resumeUrl: "", notes: "" }));
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
  return { applicationId, jobTypeId: jobType?.id ?? "", email };
}
function conversionBody(jobTypeId: string, email: string, suffix: string, overrides: object = {}) {
  return { employeeNo: `R2-${suffix}-${crypto.randomUUID().slice(0, 8)}`, email, department: "測試部", grade: "G1", title: "測試職務", jobTypeId, hireDate: "2026-09-28", salary: null, confirmed: true, ...overrides };
}
async function completeChecklist(applicationId: string) {
  const checklist = await call<{ items: Array<{ itemId: string; required: number }> }>(`/api/admin/recruitment/applications/${applicationId}/onboarding-checklist`, { headers: { Cookie: adminCookie } });
  for (const item of checklist.body.data?.items.filter((item) => item.required === 1) ?? []) {
    expect((await call(`/api/admin/recruitment/applications/${applicationId}/onboarding-checklist/${item.itemId}`, request("PUT", adminCookie, { completed: true, notes: "" }))).response.status).toBe(200);
  }
}
async function counts(applicationId: string) {
  const employees = await env.DB.prepare("SELECT COUNT(*) AS n FROM employees e JOIN recruitment_employee_conversions c ON c.employee_id = e.id WHERE c.application_id = ?").bind(applicationId).first<{ n: number }>();
  const history = await env.DB.prepare("SELECT COUNT(*) AS n FROM candidate_application_status_history WHERE application_id = ? AND to_status = 'onboarded'").bind(applicationId).first<{ n: number }>();
  const audit = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE entity_id = ? AND action = 'onboarding.convert'").bind(applicationId).first<{ n: number }>();
  const conversions = await env.DB.prepare("SELECT COUNT(*) AS n FROM recruitment_employee_conversions WHERE application_id = ?").bind(applicationId).first<{ n: number }>();
  return { employees: employees?.n ?? -1, history: history?.n ?? -1, audit: audit?.n ?? -1, conversions: conversions?.n ?? -1 };
}
async function withConcurrentWrite(path: string, cookie: string, body: object, write: () => Promise<unknown>) {
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
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body),
  }), { ...env, DB: db });
  expect(injected).toBe(true);
  return { response, body: await response.json<Envelope<{ employeeId: string; alreadyConverted: boolean; legacyBackfill: boolean }>>() };
}
beforeAll(async () => { adminCookie = await login("admin@demo.local"); employeeCookie = await login("chiahao.lin@demo.local"); });

describe("嚴格到職日", () => {
  it("拒絕溢位月日與非閏年 2/29，接受閏年 2/29", () => {
    for (const value of ["2026-02-30", "2026-02-31", "2026-04-31", "2026-13-01", "2026-00-10", "2023-02-29"]) {
      expect(() => strictIsoDate(value, "到職日")).toThrow(/有效的日曆日期|YYYY-MM-DD/);
    }
    expect(strictIsoDate("2024-02-29", "到職日")).toBe("2024-02-29");
    expect(strictIsoDate("2026-09-28", "到職日")).toBe("2026-09-28");
  });
});

describe("第二輪到職轉換安全回歸", () => {
  it("相同 payload 重送回同一員工且不新增員工、歷程或稽核", async () => {
    const { applicationId, jobTypeId, email } = await hiredApplication("重送");
    await completeChecklist(applicationId);
    const body = conversionBody(jobTypeId, email, "repeat");
    const created = await call<{ employeeId: string; alreadyConverted: boolean }>(`/api/admin/recruitment/applications/${applicationId}/convert-employee`, request("POST", adminCookie, body));
    expect(created.response.status).toBe(201);
    expect(created.body.data?.alreadyConverted).toBe(false);
    const before = await counts(applicationId);
    const repeat = await call<{ employeeId: string; alreadyConverted: boolean }>(`/api/admin/recruitment/applications/${applicationId}/convert-employee`, request("POST", adminCookie, body));
    expect(repeat.response.status).toBe(200);
    expect(repeat.body.data?.alreadyConverted).toBe(true);
    expect(repeat.body.data?.employeeId).toBe(created.body.data?.employeeId);
    expect(await counts(applicationId)).toEqual(before);
    expect(before).toEqual({ employees: 1, history: 1, audit: 1, conversions: 1 });
  });

  it("舊 transition 不可把 hired 標成到職，且不建立員工", async () => {
    const { applicationId } = await hiredApplication("舊路徑");
    await completeChecklist(applicationId);
    const before = await counts(applicationId);
    const blocked = await call(`/api/admin/recruitment/applications/${applicationId}/transition`, request("POST", adminCookie, { status: "onboarded" }));
    expect(blocked.response.status).toBe(409);
    expect(blocked.body.error?.message).toContain("確認到職並建立員工");
    expect(await env.DB.prepare("SELECT status FROM candidate_applications WHERE id = ?").bind(applicationId).first()).toEqual({ status: "hired" });
    expect(await counts(applicationId)).toEqual(before);
    expect((await call(`/api/admin/recruitment/applications/${applicationId}/transition`, request("POST", adminCookie, { status: "rejected" }))).response.status).toBe(200);
  });

  it("既有 onboarded 且無 conversion 可補建，不新增假歷程、不綁既有同 email 員工", async () => {
    const { applicationId, jobTypeId, email } = await hiredApplication("補建");
    await completeChecklist(applicationId);
    const historyBefore = await env.DB.prepare("SELECT COUNT(*) AS n FROM candidate_application_status_history WHERE application_id = ?").bind(applicationId).first<{ n: number }>();
    await env.DB.prepare("UPDATE candidate_applications SET status = 'onboarded' WHERE id = ?").bind(applicationId).run();
    await env.DB.prepare("INSERT INTO employees (id,employee_no,name,email,department,grade,title,job_type_id,hire_date,status) VALUES ('legacy-same-email','LEGACY-EMAIL','既有人',?,'人資行政部','G1','既有','jt-office','2020-01-01','active')").bind(email.toUpperCase()).run();
    const taken = conversionBody(jobTypeId, email, "taken");
    expect((await call(`/api/admin/recruitment/applications/${applicationId}/convert-employee`, request("POST", adminCookie, taken))).response.status).toBe(409);
    await env.DB.prepare("DELETE FROM employees WHERE id = 'legacy-same-email'").run();
    const body = conversionBody(jobTypeId, email, "legacy");
    const created = await call<{ employeeId: string; legacyBackfill: boolean }>(`/api/admin/recruitment/applications/${applicationId}/convert-employee`, request("POST", adminCookie, body));
    expect(created.response.status).toBe(201);
    expect(created.body.data?.legacyBackfill).toBe(true);
    const historyAfter = await env.DB.prepare("SELECT COUNT(*) AS n FROM candidate_application_status_history WHERE application_id = ? AND to_status = 'onboarded' AND from_status = 'hired'").bind(applicationId).first<{ n: number }>();
    expect(historyAfter).toEqual({ n: 0 });
    const historyTotal = await env.DB.prepare("SELECT COUNT(*) AS n FROM candidate_application_status_history WHERE application_id = ?").bind(applicationId).first<{ n: number }>();
    expect(historyTotal?.n).toBe(historyBefore?.n);
    const audit = await env.DB.prepare("SELECT details FROM audit_logs WHERE entity_id = ? AND action = 'onboarding.convert'").bind(applicationId).first<{ details: string }>();
    expect(audit?.details).toContain("legacyBackfill");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE employee_id = ?").bind(created.body.data?.employeeId).first()).toEqual({ n: 0 });
  });

  it("缺少確認、溢位日期與員工角色各自拒絕", async () => {
    const { applicationId, jobTypeId, email } = await hiredApplication("格式拒絕");
    await completeChecklist(applicationId);
    const body = conversionBody(jobTypeId, email, "format");
    expect((await call(`/api/admin/recruitment/applications/${applicationId}/convert-employee`, request("POST", adminCookie, { ...body, confirmed: false }))).response.status).toBe(422);
    expect((await call(`/api/admin/recruitment/applications/${applicationId}/convert-employee`, request("POST", adminCookie, { ...body, hireDate: "2026-02-30" }))).response.status).toBe(422);
    expect((await call(`/api/admin/recruitment/applications/${applicationId}/convert-employee`, request("POST", employeeCookie, body))).response.status).toBe(403);
    expect((await call(`/api/admin/recruitment/applications/${applicationId}/convert-employee`, request("POST", "", body))).response.status).toBe(401);
    expect(await counts(applicationId)).toEqual({ employees: 0, history: 0, audit: 0, conversions: 0 });
  });

  it("不存在申請、非 hired、缺文件、停用職務、員編與 email 衝突各自拒絕", async () => {
    const missing = await hiredApplication("不存在對照");
    const missingBody = conversionBody(missing.jobTypeId, missing.email, "missing");
    expect((await call("/api/admin/recruitment/applications/missing-application/convert-employee", request("POST", adminCookie, missingBody))).response.status).toBe(409);

    const notHired = await hiredApplication("非hired");
    await completeChecklist(notHired.applicationId);
    await env.DB.prepare("UPDATE candidate_applications SET status = 'offer' WHERE id = ?").bind(notHired.applicationId).run();
    expect((await call(`/api/admin/recruitment/applications/${notHired.applicationId}/convert-employee`, request("POST", adminCookie, conversionBody(notHired.jobTypeId, notHired.email, "offer")))).response.status).toBe(409);
    expect(await counts(notHired.applicationId)).toEqual({ employees: 0, history: 0, audit: 0, conversions: 0 });

    const incomplete = await hiredApplication("缺文件");
    expect((await call(`/api/admin/recruitment/applications/${incomplete.applicationId}/convert-employee`, request("POST", adminCookie, conversionBody(incomplete.jobTypeId, incomplete.email, "docs")))).response.status).toBe(409);
    expect(await counts(incomplete.applicationId)).toEqual({ employees: 0, history: 0, audit: 0, conversions: 0 });

    const inactive = await hiredApplication("停用職務");
    await completeChecklist(inactive.applicationId);
    const inactiveId = `jt-inactive-${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO job_types (id, name, required_level, active) VALUES (?, '停用職務', 1, 0)").bind(inactiveId).run();
    expect((await call(`/api/admin/recruitment/applications/${inactive.applicationId}/convert-employee`, request("POST", adminCookie, conversionBody(inactive.jobTypeId, inactive.email, "inactive", { jobTypeId: inactiveId })))).response.status).toBe(409);

    const numberConflict = await hiredApplication("員編衝突");
    await completeChecklist(numberConflict.applicationId);
    await env.DB.prepare("INSERT INTO employees (id,employee_no,name,email,department,grade,title,job_type_id,hire_date,status) VALUES ('conflict-no','R2-CONFLICT','衝突','other-conflict@example.com','人資行政部','G1','衝突','jt-office','2020-01-01','active')").run();
    expect((await call(`/api/admin/recruitment/applications/${numberConflict.applicationId}/convert-employee`, request("POST", adminCookie, conversionBody(numberConflict.jobTypeId, numberConflict.email, "no", { employeeNo: "R2-CONFLICT" })))).response.status).toBe(409);
    const emailConflict = await hiredApplication("email衝突");
    await completeChecklist(emailConflict.applicationId);
    await env.DB.prepare("INSERT INTO employees (id,employee_no,name,email,department,grade,title,job_type_id,hire_date,status) VALUES ('conflict-email','R2-CONFLICT-EMAIL','衝突',?,'人資行政部','G1','衝突','jt-office','2020-01-01','active')").bind(emailConflict.email.toUpperCase()).run();
    expect((await call(`/api/admin/recruitment/applications/${emailConflict.applicationId}/convert-employee`, request("POST", adminCookie, conversionBody(emailConflict.jobTypeId, emailConflict.email, "mail")))).response.status).toBe(409);
    expect(await counts(numberConflict.applicationId)).toEqual({ employees: 0, history: 0, audit: 0, conversions: 0 });
    expect(await counts(emailConflict.applicationId)).toEqual({ employees: 0, history: 0, audit: 0, conversions: 0 });
    await env.DB.prepare("DELETE FROM employees WHERE id IN ('conflict-no','conflict-email')").run();
  });

  it("預讀後寫入競爭時相同 payload 冪等且不留半套", async () => {
    const { applicationId, jobTypeId, email } = await hiredApplication("競態");
    await completeChecklist(applicationId);
    const body = conversionBody(jobTypeId, email, "race");
    const same = await withConcurrentWrite(`/api/admin/recruitment/applications/${applicationId}/convert-employee`, adminCookie, body, async () => {
      await env.DB.prepare("INSERT INTO employees (id,employee_no,name,email,department,grade,title,job_type_id,hire_date,status,salary) VALUES (?, ?, '候選人 競態', ?, '測試部', 'G1', '測試職務', ?, '2026-09-28', 'active', NULL)").bind("race-emp", body.employeeNo, body.email, body.jobTypeId).run();
      await env.DB.prepare("INSERT INTO recruitment_employee_conversions(application_id,employee_id,created_by) VALUES (?, 'race-emp', 'usr-admin')").bind(applicationId).run();
      await env.DB.prepare("UPDATE candidate_applications SET status = 'onboarded' WHERE id = ?").bind(applicationId).run();
    });
    expect(same.response.status).toBe(200);
    expect(same.body.data?.alreadyConverted).toBe(true);
    expect(same.body.data?.employeeId).toBe("race-emp");
    expect(await counts(applicationId)).toEqual({ employees: 1, history: 0, audit: 0, conversions: 1 });
  });

  it("預讀後寫入競爭時不同 payload 不留半套", async () => {
    const other = await hiredApplication("競態不同");
    await completeChecklist(other.applicationId);
    const otherBody = conversionBody(other.jobTypeId, other.email, "race2");
    const different = await withConcurrentWrite(`/api/admin/recruitment/applications/${other.applicationId}/convert-employee`, adminCookie, otherBody, async () => {
      await env.DB.prepare("INSERT INTO employees (id,employee_no,name,email,department,grade,title,job_type_id,hire_date,status) VALUES ('race-emp-2','RACE-EMP-2','另一人',?,'測試部','G2','其他',?,'2026-01-01','active')").bind(other.email, other.jobTypeId).run();
      await env.DB.prepare("INSERT INTO recruitment_employee_conversions(application_id,employee_id,created_by) VALUES (?, 'race-emp-2', 'usr-admin')").bind(other.applicationId).run();
    });
    expect(different.response.status).toBe(409);
    expect(await counts(other.applicationId)).toEqual({ employees: 1, history: 0, audit: 0, conversions: 1 });
  });

  it("預讀後寫入競爭時員編與 email 衝突不留半套", async () => {
    const third = await hiredApplication("員編衝突");
    await completeChecklist(third.applicationId);
    const thirdBody = conversionBody(third.jobTypeId, third.email, "race3", { employeeNo: "RACE-DUP" });
    const conflict = await withConcurrentWrite(`/api/admin/recruitment/applications/${third.applicationId}/convert-employee`, adminCookie, thirdBody, () => env.DB.prepare("INSERT INTO employees (id,employee_no,name,email,department,grade,title,job_type_id,hire_date,status) VALUES ('race-dup','RACE-DUP','占用','race-dup@example.com','人資行政部','G1','占用','jt-office','2020-01-01','active')").run());
    expect(conflict.response.status).toBe(409);
    expect(await counts(third.applicationId)).toEqual({ employees: 0, history: 0, audit: 0, conversions: 0 });

    const fourth = await hiredApplication("email競態");
    await completeChecklist(fourth.applicationId);
    const fourthBody = conversionBody(fourth.jobTypeId, fourth.email, "race4");
    const emailRace = await withConcurrentWrite(`/api/admin/recruitment/applications/${fourth.applicationId}/convert-employee`, adminCookie, fourthBody, () => env.DB.prepare("INSERT INTO employees (id,employee_no,name,email,department,grade,title,job_type_id,hire_date,status) VALUES ('race-email','RACE-EMAIL','占用',?,'人資行政部','G1','占用','jt-office','2020-01-01','active')").bind(fourth.email.toUpperCase()).run());
    expect(emailRace.response.status).toBe(409);
    expect(await counts(fourth.applicationId)).toEqual({ employees: 0, history: 0, audit: 0, conversions: 0 });
    await env.DB.prepare("DELETE FROM employees WHERE id IN ('race-dup','race-email')").run();
  });

  it("batch 前只把 hired 改成 onboarded 時補建成功且稽核為 legacy", async () => {
    const { applicationId, jobTypeId, email } = await hiredApplication("狀態改到職");
    await completeChecklist(applicationId);
    const historyBefore = await env.DB.prepare("SELECT COUNT(*) AS n FROM candidate_application_status_history WHERE application_id = ? AND from_status = 'hired' AND to_status = 'onboarded'").bind(applicationId).first<{ n: number }>();
    const body = conversionBody(jobTypeId, email, "stale-onboarded");
    const created = await withConcurrentWrite(`/api/admin/recruitment/applications/${applicationId}/convert-employee`, adminCookie, body, () => env.DB.prepare("UPDATE candidate_applications SET status = 'onboarded' WHERE id = ? AND status = 'hired'").bind(applicationId).run());
    expect(created.response.status).toBe(201);
    expect(created.body.data?.alreadyConverted).toBe(false);
    expect(created.body.data?.legacyBackfill).toBe(true);
    expect(await env.DB.prepare("SELECT status FROM candidate_applications WHERE id = ?").bind(applicationId).first()).toEqual({ status: "onboarded" });
    const historyAfter = await env.DB.prepare("SELECT COUNT(*) AS n FROM candidate_application_status_history WHERE application_id = ? AND from_status = 'hired' AND to_status = 'onboarded'").bind(applicationId).first<{ n: number }>();
    expect(historyAfter).toEqual(historyBefore);
    const audit = await env.DB.prepare("SELECT details FROM audit_logs WHERE entity_id = ? AND action = 'onboarding.convert'").bind(applicationId).first<{ details: string }>();
    expect(audit?.details).toContain('"legacyBackfill":true');
    expect(await counts(applicationId)).toEqual({ employees: 1, history: 0, audit: 1, conversions: 1 });
    const repeat = await call<{ alreadyConverted: boolean; legacyBackfill: boolean }>(`/api/admin/recruitment/applications/${applicationId}/convert-employee`, request("POST", adminCookie, body));
    expect(repeat.response.status).toBe(200);
    expect(repeat.body.data?.alreadyConverted).toBe(true);
    expect(repeat.body.data?.legacyBackfill).toBe(true);
  });

  it("batch 前只把 onboarded 改回 hired 時建立真歷程且稽核不是 legacy", async () => {
    const { applicationId, jobTypeId, email } = await hiredApplication("狀態改回錄取");
    await completeChecklist(applicationId);
    await env.DB.prepare("UPDATE candidate_applications SET status = 'onboarded' WHERE id = ?").bind(applicationId).run();
    const body = conversionBody(jobTypeId, email, "stale-hired");
    const created = await withConcurrentWrite(`/api/admin/recruitment/applications/${applicationId}/convert-employee`, adminCookie, body, () => env.DB.prepare("UPDATE candidate_applications SET status = 'hired' WHERE id = ? AND status = 'onboarded'").bind(applicationId).run());
    expect(created.response.status).toBe(201);
    expect(created.body.data?.alreadyConverted).toBe(false);
    expect(created.body.data?.legacyBackfill).toBe(false);
    expect(await env.DB.prepare("SELECT status FROM candidate_applications WHERE id = ?").bind(applicationId).first()).toEqual({ status: "onboarded" });
    const history = await env.DB.prepare("SELECT from_status AS fromStatus, to_status AS toStatus, note FROM candidate_application_status_history WHERE application_id = ? AND to_status = 'onboarded'").bind(applicationId).first<{ fromStatus: string; toStatus: string; note: string }>();
    expect(history).toEqual({ fromStatus: "hired", toStatus: "onboarded", note: "HR確認到職並建立員工主檔" });
    const audit = await env.DB.prepare("SELECT details FROM audit_logs WHERE entity_id = ? AND action = 'onboarding.convert'").bind(applicationId).first<{ details: string }>();
    expect(audit?.details).toBe('{"employeeCreated":true}');
    expect(await counts(applicationId)).toEqual({ employees: 1, history: 1, audit: 1, conversions: 1 });
    const repeat = await call<{ alreadyConverted: boolean; legacyBackfill: boolean }>(`/api/admin/recruitment/applications/${applicationId}/convert-employee`, request("POST", adminCookie, body));
    expect(repeat.response.status).toBe(200);
    expect(repeat.body.data?.alreadyConverted).toBe(true);
    expect(repeat.body.data?.legacyBackfill).toBe(false);
  });
});

describe("第二輪通知安全閘門", () => {
  it("乾跑不呼叫 mailer、不寫 outbox，且非管理員不可執行", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox").first<{ n: number }>();
    const dry = await call<{ dryRun: boolean; queued: boolean; preview: string }>("/api/admin/reminder-notifications/run", request("POST", adminCookie, { dryRun: true }));
    expect(dry.response.status).toBe(200);
    expect(dry.body.data).toMatchObject({ dryRun: true, queued: false });
    expect(dry.body.data?.preview).not.toMatch(/薪資|健檢結果|診斷|@/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox").first()).toEqual(before);
    expect((await call("/api/admin/reminder-notifications/run", request("POST", adminCookie, { dryRun: false }))).response.status).toBe(409);
    expect((await call("/api/admin/reminder-notifications/run", request("POST", employeeCookie, { dryRun: true }))).response.status).toBe(403);
    vi.unstubAllGlobals();
  });
});
