import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { message: string; details?: unknown };
}

let adminCookie = "";

async function call<T>(path: string, init?: RequestInit): Promise<{ response: Response; body: Envelope<T> }> {
  const response = await exports.default.fetch(`https://example.com${path}`, init);
  const body = await response.json<Envelope<T>>();
  return { response, body };
}

function adminJson(method: string, body: object): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify(body),
  };
}

async function loginAndChange(email: string, newPassword: string): Promise<string> {
  const login = await call<{ user: { role: string } }>("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Demo1234!" }),
  });
  const cookie = login.response.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(login.response.status).toBe(200);
  const changed = await call("/api/auth/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ currentPassword: "Demo1234!", newPassword }),
  });
  expect(changed.response.status).toBe(200);
  return cookie;
}

beforeAll(async () => {
  adminCookie = await loginAndChange("admin@demo.local", "AdminChanged1234!");
});

describe("M1 排課規則", () => {
  it("admin 可建立、更新與停用完整課程資料", async () => {
    const created = await call<{ course: { id: string; name: string; relatedCertificationId: string } }>(
      "/api/admin/courses",
      adminJson("POST", {
        name: "中級產品合規實務",
        competencyLevel: 2,
        courseType: "mandatory",
        durationHours: 3,
        instructor: "王講師",
        description: "整合課程 CRUD 驗證。",
        relatedCertificationId: "cert-product",
        validityMonths: 12,
        enrollmentOpen: false,
        active: true,
      }),
    );
    expect(created.response.status).toBe(201);
    expect(created.body.data?.course.relatedCertificationId).toBe("cert-product");
    const id = created.body.data?.course.id ?? "";
    const updated = await call<{ course: { name: string } }>(`/api/admin/courses/${id}`, adminJson("PATCH", {
      name: "中級產品合規實務（更新）",
      competencyLevel: 2,
      courseType: "mandatory",
      durationHours: 3.5,
      instructor: "王講師",
      description: "已更新。",
      relatedCertificationId: "cert-product",
      validityMonths: 12,
      enrollmentOpen: false,
      active: true,
    }));
    expect(updated.body.data?.course.name).toContain("更新");
    const archived = await call(`/api/admin/courses/${id}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(archived.response.status).toBe(200);
  });

  it("中級必修自動建議診所線與醫院線共 10 人，排除內勤", async () => {
    const preview = await call<{
      employees: Array<{ jobType: string; recommended: boolean }>;
    }>("/api/admin/course-sessions/assignment-preview", adminJson("POST", {
      courseId: "course-04",
      sessionDate: "2030-01-10",
      startTime: "09:00",
      endTime: "12:00",
    }));
    expect(preview.response.status).toBe(200);
    const recommended = preview.body.data?.employees.filter((employee) => employee.recommended) ?? [];
    expect(recommended).toHaveLength(10);
    expect(recommended.some((employee) => employee.jobType === "內勤")).toBe(false);
  });

  it("封鎖日阻擋建立場次並回傳原因", async () => {
    const day = await env.DB.prepare(
      "SELECT special_date AS date FROM special_days WHERE day_type = 'blackout'",
    ).first<{ date: string }>();
    const result = await call("/api/admin/course-sessions", adminJson("POST", {
      courseId: "course-01",
      sessionDate: day?.date,
      startTime: "09:00",
      endTime: "12:00",
      location: "A 教室",
      capacity: 20,
      notes: "",
    }));
    expect(result.response.status).toBe(422);
    expect(result.body.error?.message).toContain("封鎖日");
  });

  it("全員必訓日不分職務自動指派 15 名在職員工", async () => {
    const day = await call<{ specialDay: { id: string } }>("/api/admin/special-days", adminJson("POST", {
      specialDate: "2030-01-20",
      dayType: "mandatory_all",
      title: "全員合規日",
      reason: "年度共同訓練",
    }));
    expect(day.response.status).toBe(201);
    const session = await call<{ id: string; assignedCount: number }>(
      "/api/admin/course-sessions",
      adminJson("POST", {
        courseId: "course-03",
        sessionDate: "2030-01-20",
        startTime: "09:00",
        endTime: "11:00",
        location: "大會議室",
        capacity: 20,
        notes: "",
      }),
    );
    expect(session.response.status).toBe(201);
    expect(session.body.data?.assignedCount).toBe(15);
  });

  it("同員工同時段衝突先回 409，強制覆寫會留下稽核紀錄", async () => {
    const first = await call<{ id: string }>("/api/admin/course-sessions", adminJson("POST", {
      courseId: "course-06",
      sessionDate: "2030-02-01",
      startTime: "14:00",
      endTime: "16:00",
      location: "線上",
      capacity: 5,
      notes: "",
      selectedEmployeeIds: ["emp-002"],
    }));
    expect(first.response.status).toBe(201);

    const conflictedBody = {
      courseId: "course-09",
      sessionDate: "2030-02-01",
      startTime: "15:00",
      endTime: "17:00",
      location: "B 教室",
      capacity: 5,
      notes: "",
      selectedEmployeeIds: ["emp-002"],
    };
    const blocked = await call("/api/admin/course-sessions", adminJson("POST", conflictedBody));
    expect(blocked.response.status).toBe(409);

    const forced = await call<{ id: string; conflicts: unknown[] }>(
      "/api/admin/course-sessions",
      adminJson("POST", {
        ...conflictedBody,
        forceConflicts: true,
        conflictOverrideReason: "主管核准跨課程安排",
      }),
    );
    expect(forced.response.status).toBe(201);
    expect(forced.body.data?.conflicts).toHaveLength(1);
    const audit = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM conflict_overrides WHERE new_session_id = ?",
    ).bind(forced.body.data?.id).first<{ count: number }>();
    expect(audit?.count).toBe(1);
  });
});

describe("M1 出席、完訓與員工端", () => {
  it("完成出席會寫入 training_records 並即時提升完訓數", async () => {
    const session = await call<{ id: string }>("/api/admin/course-sessions", adminJson("POST", {
      courseId: "course-04",
      sessionDate: "2026-01-10",
      startTime: "09:00",
      endTime: "12:00",
      location: "A 教室",
      capacity: 5,
      notes: "",
      selectedEmployeeIds: ["emp-002"],
    }));
    expect(session.response.status).toBe(201);
    const attendance = await call(`/api/admin/course-sessions/${session.body.data?.id}/attendance`, adminJson("PUT", {
      records: [{ employeeId: "emp-002", status: "completed" }],
    }));
    expect(attendance.response.status).toBe(200);
    const records = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM training_records WHERE employee_id = 'emp-002' AND course_id = 'course-04'",
    ).first<{ count: number }>();
    expect(records?.count).toBe(1);

    const completion = await call<{
      employees: Array<{ id: string; completedCount: number; completionRate: number }>;
    }>("/api/admin/completion?department=%E8%A8%BA%E6%89%80%E4%BA%8B%E6%A5%AD%E9%83%A8", {
      headers: { Cookie: adminCookie },
    });
    const employee = completion.body.data?.employees.find((item) => item.id === "emp-002");
    expect(employee?.completedCount).toBeGreaterThanOrEqual(1);
    expect(employee?.completionRate).toBeGreaterThan(0);
  });

  it("員工可報名有名額的選修課，課表與完訓 API 只回自己的資料", async () => {
    const employeeCookie = await loginAndChange("yating.chen@demo.local", "EmployeeChanged1234!");
    const open = await call<{ sessions: Array<{ id: string; alreadyEnrolled: number }> }>(
      "/api/employee/courses/open",
      { headers: { Cookie: employeeCookie } },
    );
    expect(open.response.status).toBe(200);
    const available = open.body.data?.sessions.find((session) => session.alreadyEnrolled === 0);
    expect(available).toBeTruthy();

    const enrolled = await call(`/api/employee/course-sessions/${available?.id}/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employeeCookie },
      body: "{}",
    });
    expect(enrolled.response.status).toBe(201);

    const schedule = await call<{ sessions: Array<{ id: string }> }>("/api/employee/schedule", {
      headers: { Cookie: employeeCookie },
    });
    expect(schedule.body.data?.sessions.some((session) => session.id === available?.id)).toBe(true);
    const leaked = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM enrollments
      WHERE course_session_id = ? AND employee_id <> 'emp-003' AND source = 'self'
    `).bind(available?.id).first<{ count: number }>();
    expect(leaked?.count).toBe(0);
  });
});
