import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { message: string; details?: unknown };
}

interface FunnelStage {
  stage: string;
  label: string;
  currentCount: number;
  enteredCount: number;
}

let adminCookie = "";
let employeeCookie = "";

async function call<T>(path: string, init?: RequestInit): Promise<{
  response: Response;
  body: Envelope<T>;
}> {
  const response = await exports.default.fetch(`https://example.com${path}`, init);
  return { response, body: await response.json<Envelope<T>>() };
}

function jsonRequest(method: string, cookie: string, body: object): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  };
}

function adminJson(method: string, body: object): RequestInit {
  return jsonRequest(method, adminCookie, body);
}

async function loginAndChange(email: string, newPassword: string): Promise<string> {
  const login = await call("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Demo1234!" }),
  });
  expect(login.response.status).toBe(200);
  const cookie = login.response.headers.get("set-cookie")?.split(";")[0] ?? "";
  const changed = await call("/api/auth/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ currentPassword: "Demo1234!", newPassword }),
  });
  expect(changed.response.status).toBe(200);
  return cookie;
}

async function funnel(): Promise<FunnelStage[]> {
  const result = await call<{ stages: FunnelStage[] }>("/api/admin/recruitment/funnel", {
    headers: { Cookie: adminCookie },
  });
  expect(result.response.status).toBe(200);
  return result.body.data?.stages ?? [];
}

function count(stages: FunnelStage[], stage: string, field: "currentCount" | "enteredCount"): number {
  return stages.find((item) => item.stage === stage)?.[field] ?? 0;
}

beforeAll(async () => {
  adminCookie = await loginAndChange("admin@demo.local", "AdminM3Changed1234!");
  employeeCookie = await loginAndChange("chiahao.lin@demo.local", "EmployeeM3Changed1234!");
});

describe("M3 招募 CRUD、權限與提醒", () => {
  it("employee 在 API 層無法讀寫面試評分與核薪敏感資料", async () => {
    const salary = await call("/api/admin/recruitment/salary-approvals", {
      headers: { Cookie: employeeCookie },
    });
    expect(salary.response.status).toBe(403);

    const interviews = await call("/api/admin/recruitment/interviews", {
      headers: { Cookie: employeeCookie },
    });
    expect(interviews.response.status).toBe(403);

    const scores = await call(
      "/api/admin/recruitment/interviews/not-allowed/scores",
      jsonRequest("PUT", employeeCookie, {
        scores: [{ dimension: "專業能力", score: 5, comments: "不應寫入" }],
      }),
    );
    expect(scores.response.status).toBe(403);
  });

  it("職缺、人才庫與自訂到職文件提供可持久化 CRUD", async () => {
    const opening = await call<{ id: string }>("/api/admin/recruitment/job-openings", adminJson("POST", {
      title: "M3 CRUD 測試職缺",
      department: "營運部",
      headcount: 1,
      description: "用於驗證新增、修改與刪除。",
      status: "open",
    }));
    expect(opening.response.status).toBe(201);
    const openingId = opening.body.data?.id ?? "";
    const updatedOpening = await call(
      `/api/admin/recruitment/job-openings/${openingId}`,
      adminJson("PATCH", {
        title: "M3 CRUD 測試職缺（更新）",
        department: "營運部",
        headcount: 2,
        description: "已更新。",
        status: "paused",
      }),
    );
    expect(updatedOpening.response.status).toBe(200);
    const deletedOpening = await call(
      `/api/admin/recruitment/job-openings/${openingId}`,
      { method: "DELETE", headers: { Cookie: adminCookie } },
    );
    expect(deletedOpening.response.status).toBe(200);

    const candidate = await call<{ id: string }>("/api/admin/recruitment/candidates", adminJson("POST", {
      name: "CRUD 候選人",
      email: "crud.candidate@example.com",
      phone: "",
      source: "人才庫",
      resumeUrl: "https://example.com/resume/crud",
      notes: "原始備註",
    }));
    expect(candidate.response.status).toBe(201);
    const candidateId = candidate.body.data?.id ?? "";
    const updatedCandidate = await call(
      `/api/admin/recruitment/candidates/${candidateId}`,
      adminJson("PATCH", {
        name: "CRUD 候選人（更新）",
        email: "crud.candidate@example.com",
        phone: "0911000000",
        source: "人才庫",
        resumeUrl: "https://example.com/resume/crud-v2",
        notes: "更新備註",
      }),
    );
    expect(updatedCandidate.response.status).toBe(200);
    const searched = await call<{
      candidates: Array<{ id: string; name: string }>;
    }>("/api/admin/recruitment/candidates?search=0911000000", {
      headers: { Cookie: adminCookie },
    });
    expect(searched.body.data?.candidates.some((item) => item.id === candidateId)).toBe(true);
    const deletedCandidate = await call(
      `/api/admin/recruitment/candidates/${candidateId}`,
      { method: "DELETE", headers: { Cookie: adminCookie } },
    );
    expect(deletedCandidate.response.status).toBe(200);

    const item = await call<{ id: string }>("/api/admin/recruitment/onboarding-items", adminJson("POST", {
      name: "M3 自訂文件",
      required: false,
      active: true,
    }));
    expect(item.response.status).toBe(201);
    const itemId = item.body.data?.id ?? "";
    const updatedItem = await call(
      `/api/admin/recruitment/onboarding-items/${itemId}`,
      adminJson("PATCH", { name: "M3 自訂文件（更新）", required: true, active: true }),
    );
    expect(updatedItem.response.status).toBe(200);
    const archived = await call(
      `/api/admin/recruitment/onboarding-items/${itemId}`,
      { method: "DELETE", headers: { Cookie: adminCookie } },
    );
    expect(archived.response.status).toBe(200);
  });

  // 離職員工的試用期已無需追蹤，提醒不應再出現。證照提醒（src/server/m2.ts:211）
  // 與必修指派早已有 status = 'active' 過濾，此處補上同樣的一致性保證。
  it("離職員工的試用期不出現在提醒中", async () => {
    // 明確設定提醒天數，讓提醒視窗不受測試執行順序影響。
    await call("/api/admin/recruitment/probation-settings", adminJson("PATCH", { reminderDays: 30 }));

    // 到期日落在提醒視窗內（25 天後），確保兩筆都「有資格」進提醒，
    // 唯一差別只剩在職狀態。
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - 65);
    const startDate = start.toISOString().slice(0, 10);

    async function createProbation(employeeId: string): Promise<string> {
      const created = await call<{ id: string }>(
        "/api/admin/recruitment/probations",
        adminJson("POST", {
          employeeId,
          candidateApplicationId: null,
          startDate,
          durationDays: 90,
          result: null,
          notes: "離職過濾測試",
        }),
      );
      expect(created.response.status).toBe(201);
      return created.body.data?.id ?? "";
    }

    const inactiveId = await createProbation("emp-011"); // 0007 標記為離職
    const activeId = await createProbation("emp-012"); // 在職，作為對照組

    const dashboard = await call<{
      probationReminders: Array<{ id: string }>;
    }>("/api/admin/dashboard", { headers: { Cookie: adminCookie } });
    const reminderIds = dashboard.body.data?.probationReminders.map((item) => item.id) ?? [];

    // 對照組必須出現，否則代表提醒視窗設錯，這條測試就驗不到 status 過濾。
    expect(reminderIds).toContain(activeId);
    expect(reminderIds).not.toContain(inactiveId);
  });

  it("試用期依到職日計算到期日，設定天數內同時出現在試用期與管理儀表板提醒", async () => {
    const settings = await call(
      "/api/admin/recruitment/probation-settings",
      adminJson("PATCH", { reminderDays: 30 }),
    );
    expect(settings.response.status).toBe(200);

    const start = new Date();
    start.setUTCDate(start.getUTCDate() - 65);
    const startDate = start.toISOString().slice(0, 10);
    const probation = await call<{ id: string; dueDate: string }>(
      "/api/admin/recruitment/probations",
      adminJson("POST", {
        employeeId: "emp-015",
        candidateApplicationId: null,
        startDate,
        durationDays: 90,
        result: null,
        notes: "30 天內到期提醒測試",
      }),
    );
    expect(probation.response.status).toBe(201);
    const probationId = probation.body.data?.id ?? "";
    const expectedDue = new Date(`${startDate}T00:00:00Z`);
    expectedDue.setUTCDate(expectedDue.getUTCDate() + 90);
    expect(probation.body.data?.dueDate).toBe(expectedDue.toISOString().slice(0, 10));

    const list = await call<{
      reminders: Array<{ id: string }>;
    }>("/api/admin/recruitment/probations", { headers: { Cookie: adminCookie } });
    expect(list.body.data?.reminders.some((item) => item.id === probationId)).toBe(true);

    const dashboard = await call<{
      probationReminders: Array<{ id: string }>;
    }>("/api/admin/dashboard", { headers: { Cookie: adminCookie } });
    expect(dashboard.body.data?.probationReminders.some((item) => item.id === probationId)).toBe(true);

    const completed = await call(
      `/api/admin/recruitment/probations/${probationId}`,
      adminJson("PATCH", {
        employeeId: "emp-015",
        candidateApplicationId: null,
        startDate,
        durationDays: 90,
        result: "passed",
        notes: "試用通過",
      }),
    );
    expect(completed.response.status).toBe(200);
    const after = await call<{ reminders: Array<{ id: string }> }>(
      "/api/admin/recruitment/probations",
      { headers: { Cookie: adminCookie } },
    );
    expect(after.body.data?.reminders.some((item) => item.id === probationId)).toBe(false);
  });
});

describe("M3 驗收項目 8：投遞到到職與漏斗", () => {
  it("逐階段完成面試、核薪、錄取、文件與到職，漏斗 current/entered 數字同步更新", async () => {
    const baseline = await funnel();
    const opening = await call<{ id: string }>("/api/admin/recruitment/job-openings", adminJson("POST", {
      title: "資深醫藥業務代表",
      department: "醫院事業部",
      headcount: 1,
      description: "負責重點醫院客戶與產品推廣。",
      status: "open",
    }));
    const openingId = opening.body.data?.id ?? "";
    const candidate = await call<{ id: string }>("/api/admin/recruitment/candidates", adminJson("POST", {
      name: "全流程候選人",
      email: "journey@example.com",
      phone: "0912345678",
      source: "LinkedIn",
      resumeUrl: "https://example.com/resume/journey",
      notes: "M3 驗收項目 8",
    }));
    const candidateId = candidate.body.data?.id ?? "";
    const application = await call<{ id: string }>(
      `/api/admin/recruitment/candidates/${candidateId}/applications`,
      adminJson("POST", { jobOpeningId: openingId }),
    );
    const applicationId = application.body.data?.id ?? "";
    expect(application.response.status).toBe(201);

    const secondApplication = await call<{ id: string }>(
      `/api/admin/recruitment/candidates/${candidateId}/applications`,
      adminJson("POST", { jobOpeningId: "job-01" }),
    );
    expect(secondApplication.response.status).toBe(201);
    const talentPool = await call<{
      candidates: Array<{ id: string; applications: Array<{ id: string }> }>;
    }>("/api/admin/recruitment/candidates?search=journey%40example.com", {
      headers: { Cookie: adminCookie },
    });
    expect(talentPool.body.data?.candidates[0]?.applications).toHaveLength(2);

    let stats = await funnel();
    expect(count(stats, "applied", "currentCount")).toBe(
      count(baseline, "applied", "currentCount") + 2,
    );
    expect(count(stats, "applied", "enteredCount")).toBe(
      count(baseline, "applied", "enteredCount") + 2,
    );

    const screening = await call(
      `/api/admin/recruitment/applications/${applicationId}/transition`,
      adminJson("POST", { status: "screening", note: "履歷符合職務需求" }),
    );
    expect(screening.response.status).toBe(200);
    stats = await funnel();
    expect(count(stats, "applied", "currentCount")).toBe(
      count(baseline, "applied", "currentCount") + 1,
    );
    expect(count(stats, "screening", "currentCount")).toBe(
      count(baseline, "screening", "currentCount") + 1,
    );

    const skipped = await call(
      `/api/admin/recruitment/applications/${applicationId}/transition`,
      adminJson("POST", { status: "salary_approval", note: "不可跳階" }),
    );
    expect(skipped.response.status).toBe(409);

    const interviewStage = await call(
      `/api/admin/recruitment/applications/${applicationId}/transition`,
      adminJson("POST", { status: "interview", note: "安排兩輪面試" }),
    );
    expect(interviewStage.response.status).toBe(200);
    stats = await funnel();
    expect(count(stats, "interview", "currentCount")).toBe(
      count(baseline, "interview", "currentCount") + 1,
    );

    const firstInterview = await call<{ id: string }>(
      "/api/admin/recruitment/interviews",
      adminJson("POST", {
        applicationId,
        roundNumber: 1,
        scheduledAt: "2026-08-03T02:00:00.000Z",
        interviewerName: "業務主管",
        location: "總公司會議室",
        status: "completed",
        notes: "第一輪主管面談",
      }),
    );
    expect(firstInterview.response.status).toBe(201);
    const firstInterviewId = firstInterview.body.data?.id ?? "";
    const scoreResult = await call(
      `/api/admin/recruitment/interviews/${firstInterviewId}/scores`,
      adminJson("PUT", {
        scores: [
          { dimension: "專業能力", score: 4, comments: "醫藥產品知識扎實" },
          { dimension: "溝通表達", score: 5, comments: "邏輯清楚" },
          { dimension: "文化契合", score: 4, comments: "價值觀一致" },
        ],
      }),
    );
    expect(scoreResult.response.status).toBe(200);
    const secondInterview = await call<{ id: string }>(
      "/api/admin/recruitment/interviews",
      adminJson("POST", {
        applicationId,
        roundNumber: 2,
        scheduledAt: "2026-08-05T06:00:00.000Z",
        interviewerName: "總經理",
        location: "視訊",
        status: "scheduled",
        notes: "第二輪文化面談",
      }),
    );
    expect(secondInterview.response.status).toBe(201);
    const interviews = await call<{
      interviews: Array<{ id: string; roundNumber: number; scores: unknown[] }>;
    }>(`/api/admin/recruitment/interviews?applicationId=${applicationId}`, {
      headers: { Cookie: adminCookie },
    });
    expect(interviews.body.data?.interviews).toHaveLength(2);
    expect(
      interviews.body.data?.interviews.find((item) => item.id === firstInterviewId)?.scores,
    ).toHaveLength(3);

    const salaryStage = await call(
      `/api/admin/recruitment/applications/${applicationId}/transition`,
      adminJson("POST", { status: "salary_approval", note: "面試通過" }),
    );
    expect(salaryStage.response.status).toBe(200);
    const salary = await call(
      `/api/admin/recruitment/salary-approvals/${applicationId}`,
      adminJson("PUT", {
        expectedSalary: 72000,
        suggestedSalary: 70000,
        approvedSalary: 71000,
        compensationNotes: "另含年度績效獎金與業務獎金",
        status: "approved",
      }),
    );
    expect(salary.response.status).toBe(200);
    stats = await funnel();
    expect(count(stats, "salary_approval", "currentCount")).toBe(
      count(baseline, "salary_approval", "currentCount") + 1,
    );

    const offerStage = await call(
      `/api/admin/recruitment/applications/${applicationId}/transition`,
      adminJson("POST", { status: "offer", note: "核薪完成" }),
    );
    expect(offerStage.response.status).toBe(200);
    const template = await call<{ noticeText: string }>(
      `/api/admin/recruitment/offers/${applicationId}/template`,
      { headers: { Cookie: adminCookie } },
    );
    expect(template.body.data?.noticeText).toContain("全流程候選人");
    expect(template.body.data?.noticeText).toContain("71,000");
    const accepted = await call(
      `/api/admin/recruitment/offers/${applicationId}`,
      adminJson("PUT", { status: "accepted", noticeText: template.body.data?.noticeText }),
    );
    expect(accepted.response.status).toBe(200);
    stats = await funnel();
    expect(count(stats, "offer", "currentCount")).toBe(
      count(baseline, "offer", "currentCount") + 1,
    );

    const hired = await call(
      `/api/admin/recruitment/applications/${applicationId}/transition`,
      adminJson("POST", { status: "hired", note: "候選人接受錄取" }),
    );
    expect(hired.response.status).toBe(200);

    const customItem = await call<{ id: string }>(
      "/api/admin/recruitment/onboarding-items",
      adminJson("POST", { name: "保密協議（全流程）", required: true, active: true }),
    );
    expect(customItem.response.status).toBe(201);
    const checklist = await call<{
      items: Array<{ itemId: string; required: number; completed: number }>;
    }>(`/api/admin/recruitment/applications/${applicationId}/onboarding-checklist`, {
      headers: { Cookie: adminCookie },
    });
    const requiredItems = checklist.body.data?.items.filter((item) => item.required === 1) ?? [];
    expect(requiredItems.length).toBeGreaterThanOrEqual(5);
    for (const item of requiredItems) {
      const toggled = await call(
        `/api/admin/recruitment/applications/${applicationId}/onboarding-checklist/${item.itemId}`,
        adminJson("PUT", { completed: true, notes: "已核對正本" }),
      );
      expect(toggled.response.status).toBe(200);
    }
    const persisted = await call<{
      items: Array<{ itemId: string; completed: number; completedAt: string | null }>;
    }>(`/api/admin/recruitment/applications/${applicationId}/onboarding-checklist`, {
      headers: { Cookie: adminCookie },
    });
    expect(
      persisted.body.data?.items
        .filter((item) => requiredItems.some((required) => required.itemId === item.itemId))
        .every((item) => item.completed === 1 && item.completedAt),
    ).toBe(true);

    const onboarded = await call(
      `/api/admin/recruitment/applications/${applicationId}/transition`,
      adminJson("POST", { status: "onboarded", note: "2026-08-17 正式到職" }),
    );
    expect(onboarded.response.status).toBe(200);
    stats = await funnel();
    expect(count(stats, "hired", "currentCount")).toBe(
      count(baseline, "hired", "currentCount"),
    );
    expect(count(stats, "onboarded", "currentCount")).toBe(
      count(baseline, "onboarded", "currentCount") + 1,
    );
    for (const stage of ["screening", "interview", "salary_approval", "offer", "hired", "onboarded"]) {
      expect(count(stats, stage, "enteredCount")).toBe(
        count(baseline, stage, "enteredCount") + 1,
      );
    }

    const history = await call<{
      history: Array<{ fromStatus: string | null; toStatus: string; changedAt: string }>;
    }>(`/api/admin/recruitment/applications/${applicationId}/history`, {
      headers: { Cookie: adminCookie },
    });
    expect(history.body.data?.history.map((item) => item.toStatus)).toEqual([
      "applied",
      "screening",
      "interview",
      "salary_approval",
      "offer",
      "hired",
      "onboarded",
    ]);
    expect(history.body.data?.history.every((item) => item.changedAt)).toBe(true);
  });
});
