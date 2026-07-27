import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { message: string; details?: unknown };
}

let adminCookie = "";

async function call<T>(path: string, init?: RequestInit): Promise<{
  response: Response;
  body: Envelope<T>;
}> {
  const response = await exports.default.fetch(`https://example.com${path}`, init);
  return { response, body: await response.json<Envelope<T>>() };
}

function adminJson(method: string, body: object): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify(body),
  };
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

beforeAll(async () => {
  adminCookie = await loginAndChange("admin@demo.local", "AdminM2Changed1234!");
});

describe("M2 必修清單與選修報名", () => {
  it("依 D1 職務級距自動推導每位員工必修課與完成狀態", async () => {
    const result = await call<{
      employees: Array<{
        employeeId: string;
        jobType: string;
        requiredLevel: number;
        requiredCount: number;
        courses: Array<{ competencyLevel: number; completed: boolean }>;
      }>;
    }>("/api/admin/mandatory-training", { headers: { Cookie: adminCookie } });
    expect(result.response.status).toBe(200);
    const office = result.body.data?.employees.find((employee) => employee.jobType === "內勤");
    const clinic = result.body.data?.employees.find((employee) => employee.employeeId === "emp-002");
    const hospital = result.body.data?.employees.find((employee) => employee.jobType === "醫院線");
    expect(office?.requiredLevel).toBe(1);
    expect(office?.courses.every((course) => course.competencyLevel === 1)).toBe(true);
    expect(clinic?.requiredLevel).toBe(2);
    expect(clinic?.courses.some((course) => course.competencyLevel === 2)).toBe(true);
    expect(clinic?.courses.some((course) => course.competencyLevel === 3)).toBe(false);
    expect(hospital?.courses.some((course) => course.competencyLevel === 3)).toBe(true);
  });

  it("報名可在直接核准與 admin 審核兩種模式間切換", async () => {
    const directEmployee = await loginAndChange(
      "chihming.chang@demo.local",
      "DirectM2Changed1234!",
    );
    const direct = await call<{ enrollmentStatus: string; status: string }>(
      "/api/employee/course-sessions/cs-03/enroll",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: directEmployee },
        body: "{}",
      },
    );
    expect(direct.response.status).toBe(201);
    expect(direct.body.data).toMatchObject({
      enrollmentStatus: "enrolled",
      status: "approved",
    });

    const configured = await call<{ settings: { electiveEnrollmentRequiresApproval: boolean } }>(
      "/api/admin/training-settings",
      adminJson("PATCH", {
        certificationReminderDays: 60,
        electiveEnrollmentRequiresApproval: true,
      }),
    );
    expect(configured.body.data?.settings.electiveEnrollmentRequiresApproval).toBe(true);

    const approvalEmployee = await loginAndChange(
      "peishan.li@demo.local",
      "ApprovalM2Changed1234!",
    );
    const pending = await call<{ enrollmentStatus: string; status: string }>(
      "/api/employee/course-sessions/cs-05/enroll",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: approvalEmployee },
        body: "{}",
      },
    );
    expect(pending.response.status).toBe(201);
    expect(pending.body.data).toMatchObject({
      enrollmentStatus: "waitlisted",
      status: "pending",
    });

    const requests = await call<{
      requests: Array<{ id: string; employeeId: string; status: string }>;
    }>("/api/admin/enrollment-requests", { headers: { Cookie: adminCookie } });
    const request = requests.body.data?.requests.find((item) => item.employeeId === "emp-005");
    expect(request?.status).toBe("waitlisted");
    const approved = await call<{ status: string }>(
      `/api/admin/enrollment-requests/${request?.id}`,
      adminJson("PATCH", { action: "approve", note: "課程名額確認" }),
    );
    expect(approved.response.status).toBe(200);
    expect(approved.body.data?.status).toBe("enrolled");
    const row = await env.DB.prepare(`
      SELECT enrollment_status AS status, reviewed_by AS reviewedBy
      FROM enrollments WHERE id = ?
    `).bind(request?.id).first<{ status: string; reviewedBy: string }>();
    expect(row).toMatchObject({ status: "enrolled", reviewedBy: "usr-admin" });
  });
});

describe("M2 測驗紀錄", () => {
  it("場次測驗可 CRUD，成績依門檻判定且不通過自動標記補訓", async () => {
    const created = await call<{ id: string }>("/api/admin/tests", adminJson("POST", {
      courseSessionId: "cs-01",
      name: "公司法規測驗",
      passingScore: 70,
    }));
    expect(created.response.status).toBe(201);
    const testId = created.body.data?.id ?? "";

    const recorded = await call<{ recordedCount: number }>(
      `/api/admin/tests/${testId}/results`,
      adminJson("PUT", {
        records: [
          { employeeId: "emp-002", score: 88 },
          { employeeId: "emp-003", score: 55 },
        ],
      }),
    );
    expect(recorded.body.data?.recordedCount).toBe(2);
    const results = await env.DB.prepare(`
      SELECT employee_id AS employeeId, passed, retraining_required AS retrainingRequired
      FROM test_results WHERE test_id = ? ORDER BY employee_id
    `).bind(testId).all<{ employeeId: string; passed: number; retrainingRequired: number }>();
    expect(results.results).toEqual([
      { employeeId: "emp-002", passed: 1, retrainingRequired: 0 },
      { employeeId: "emp-003", passed: 0, retrainingRequired: 1 },
    ]);

    const updated = await call(`/api/admin/tests/${testId}`, adminJson("PATCH", {
      courseSessionId: "cs-01",
      name: "公司法規測驗（修訂）",
      passingScore: 90,
    }));
    expect(updated.response.status).toBe(200);
    const recalculated = await env.DB.prepare(`
      SELECT passed, retraining_required AS retrainingRequired
      FROM test_results WHERE test_id = ? AND employee_id = 'emp-002'
    `).bind(testId).first<{ passed: number; retrainingRequired: number }>();
    expect(recalculated).toEqual({ passed: 0, retrainingRequired: 1 });

    const listed = await call<{
      tests: Array<{ id: string; results: Array<{ employeeId: string; score: number }> }>;
    }>(`/api/admin/tests?sessionId=cs-01`, { headers: { Cookie: adminCookie } });
    expect(listed.body.data?.tests.find((test) => test.id === testId)?.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ employeeId: "emp-002", score: 88 })]),
    );
    const deleted = await call(`/api/admin/tests/${testId}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(deleted.response.status).toBe(200);
  });
});

describe("M2 證照、提醒與訓練矩陣", () => {
  it("員工證照與證照類型提供完整 CRUD", async () => {
    const type = await call<{ certificationType: { id: string } }>(
      "/api/admin/certification-types",
      adminJson("POST", {
        name: "冷鏈運輸認證",
        issuer: "台灣冷鏈協會",
        defaultValidityMonths: 24,
        active: true,
      }),
    );
    expect(type.response.status).toBe(201);
    const typeId = type.body.data?.certificationType.id ?? "";
    const created = await call<{ id: string }>(
      "/api/admin/employee-certifications",
      adminJson("POST", {
        employeeId: "emp-006",
        certificationId: typeId,
        certificateNumber: "COLD-001",
        issuedAt: "2026-01-10",
        expiresAt: "2028-01-10",
        notes: "首次核發",
      }),
    );
    expect(created.response.status).toBe(201);
    const certificationId = created.body.data?.id ?? "";
    const updated = await call(
      `/api/admin/employee-certifications/${certificationId}`,
      adminJson("PATCH", {
        employeeId: "emp-006",
        certificationId: typeId,
        certificateNumber: "COLD-001-R",
        issuedAt: "2026-01-10",
        expiresAt: "2028-02-10",
        notes: "修正效期",
      }),
    );
    expect(updated.response.status).toBe(200);
    const listed = await call<{
      certifications: Array<{ id: string; certificateNumber: string }>;
    }>("/api/admin/employee-certifications?employeeId=emp-006", {
      headers: { Cookie: adminCookie },
    });
    expect(listed.body.data?.certifications).toContainEqual(
      expect.objectContaining({ id: certificationId, certificateNumber: "COLD-001-R" }),
    );
    const deleted = await call(`/api/admin/employee-certifications/${certificationId}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(deleted.response.status).toBe(200);
    const archivedType = await call(`/api/admin/certification-types/${typeId}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(archivedType.response.status).toBe(200);
  });

  it("seed 的 25 天到期證照同時出現在 admin 儀表板與該員工首頁", async () => {
    await call("/api/admin/training-settings", adminJson("PATCH", {
      certificationReminderDays: 30,
      electiveEnrollmentRequiresApproval: true,
    }));
    const adminDashboard = await call<{
      certificationReminders: Array<{
        id: string;
        employeeId: string;
        daysUntilExpiry: number;
      }>;
    }>("/api/admin/dashboard", { headers: { Cookie: adminCookie } });
    const adminReminder = adminDashboard.body.data?.certificationReminders.find(
      (item) => item.id === "ec-01",
    );
    expect(adminDashboard.response.status).toBe(200);
    expect(adminReminder).toMatchObject({ employeeId: "emp-002" });
    expect(adminReminder?.daysUntilExpiry).toBeGreaterThanOrEqual(24);
    expect(adminReminder?.daysUntilExpiry).toBeLessThanOrEqual(25);

    const employeeCookie = await loginAndChange(
      "chiahao.lin@demo.local",
      "ReminderM2Changed1234!",
    );
    const employeeHome = await call<{
      certificationReminders: Array<{
        id: string;
        employeeId: string;
        daysUntilExpiry: number;
      }>;
    }>("/api/employee/home", { headers: { Cookie: employeeCookie } });
    expect(employeeHome.response.status).toBe(200);
    expect(employeeHome.body.data?.certificationReminders).toContainEqual(
      expect.objectContaining({ id: "ec-01", employeeId: "emp-002" }),
    );
  });

  it("職務類型 × 必修課矩陣計算百分比並套用紅黃綠門檻", async () => {
    // 0009 的歷史種子資料已讓內勤（jt-office）4 人對 course-01／02／03 累積了
    // 完訓紀錄，若不清除會與這裡刻意建構的 75%／100%／0% 情境互相污染。
    // 本測試驗證的是矩陣計算邏輯本身，不依賴種子資料現況，故先清空這 4 人
    // 在這三門課上的既有紀錄，再灌入本測試要控制的固定情境。
    await env.DB.prepare(`
      DELETE FROM training_records
      WHERE course_id IN ('course-01', 'course-02', 'course-03')
        AND employee_id IN ('emp-001', 'emp-004', 'emp-007', 'emp-010')
    `).run();
    const records = [
      ["matrix-yellow-1", "emp-001", "course-01", "cs-01", "enr-cs01-emp-001"],
      ["matrix-yellow-2", "emp-004", "course-01", "cs-01", "enr-cs01-emp-004"],
      ["matrix-yellow-3", "emp-007", "course-01", "cs-01", "enr-cs01-emp-007"],
      ["matrix-green-1", "emp-001", "course-03", "cs-06", "enr-cs06-emp-001"],
      ["matrix-green-2", "emp-004", "course-03", "cs-06", "enr-cs06-emp-004"],
      ["matrix-green-3", "emp-007", "course-03", "cs-06", "enr-cs06-emp-007"],
      ["matrix-green-4", "emp-010", "course-03", "cs-06", "enr-cs06-emp-010"],
    ];
    await env.DB.batch(records.map((record) => env.DB.prepare(`
      INSERT INTO training_records (
        id, employee_id, course_id, course_session_id, enrollment_id, completed_at, hours
      ) VALUES (?, ?, ?, ?, ?, '2026-07-01T00:00:00.000Z', 2)
    `).bind(...record)));
    const matrix = await call<{
      cells: Array<{
        jobTypeId: string;
        courseId: string;
        completionRate: number | null;
        status: string;
      }>;
    }>("/api/admin/training-matrix", { headers: { Cookie: adminCookie } });
    expect(matrix.response.status).toBe(200);
    const officeCells = matrix.body.data?.cells.filter((cell) => cell.jobTypeId === "jt-office");
    expect(officeCells).toContainEqual(expect.objectContaining({
      courseId: "course-01",
      completionRate: 75,
      status: "yellow",
    }));
    expect(officeCells).toContainEqual(expect.objectContaining({
      courseId: "course-03",
      completionRate: 100,
      status: "green",
    }));
    expect(officeCells).toContainEqual(expect.objectContaining({
      courseId: "course-02",
      completionRate: 0,
      status: "red",
    }));
  });
});
