import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { message: string; details?: unknown };
}

interface EmployeeRecord {
  id: string;
  employeeNo: string;
  name: string;
  email: string;
  department: string;
  grade: string;
  title: string;
  jobTypeId: string;
  jobType: string;
  hireDate: string;
  terminationDate: string | null;
  status: "active" | "inactive";
  salary: number | null;
}

let adminCookie = "";
let employeeCookie = "";

async function call<T>(path: string, init?: RequestInit): Promise<{ response: Response; body: Envelope<T> }> {
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

function newEmployeeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    employeeNo: "E900",
    name: "測試新人",
    email: "crud.newhire@demo.local",
    department: "人資行政部",
    grade: "G1",
    title: "測試專員",
    jobTypeId: "jt-office",
    hireDate: "2024-05-01",
    salary: 45000,
    ...overrides,
  };
}

beforeAll(async () => {
  adminCookie = await loginAndChange("admin@demo.local", "AdminEmpCrudChanged1234!");
  employeeCookie = await loginAndChange("chiahao.lin@demo.local", "EmployeeEmpCrudChanged1234!");
});

describe("員工主檔 CRUD（POST／PATCH /api/admin/employees）", () => {
  it("admin 可建立員工，回傳完整欄位", async () => {
    const created = await call<{ employee: EmployeeRecord }>(
      "/api/admin/employees",
      adminJson("POST", newEmployeeBody()),
    );
    expect(created.response.status).toBe(201);
    expect(created.body.data?.employee).toMatchObject({
      employeeNo: "E900",
      name: "測試新人",
      email: "crud.newhire@demo.local",
      jobTypeId: "jt-office",
      jobType: "內勤",
      status: "active",
      terminationDate: null,
      salary: 45000,
    });
  });

  // 員工管理頁的 PATCH 採整筆取代語意，清單若不回完整欄位就湊不出請求；
  // 離職者若不在清單裡，也無從編輯或復職。這兩點是該頁能否運作的前提。
  it("清單回傳 PATCH 所需的完整欄位", async () => {
    const list = await call<{ employees: EmployeeRecord[] }>(
      "/api/admin/employees",
      { headers: { Cookie: adminCookie } },
    );
    expect(list.response.status).toBe(200);
    const sample = list.body.data?.employees[0];
    // 缺任何一欄，前端就無法送出整筆取代的 PATCH。
    for (const field of [
      "id", "employeeNo", "name", "email", "department", "grade",
      "title", "jobTypeId", "jobType", "hireDate", "status",
    ] as const) {
      expect(sample).toHaveProperty(field);
    }
  });

  it("預設只回在職者，includeInactive=true 才帶出離職者", async () => {
    const active = await call<{ employees: EmployeeRecord[] }>(
      "/api/admin/employees",
      { headers: { Cookie: adminCookie } },
    );
    const all = await call<{ employees: EmployeeRecord[] }>(
      "/api/admin/employees?includeInactive=true",
      { headers: { Cookie: adminCookie } },
    );
    const activeList = active.body.data?.employees ?? [];
    const allList = all.body.data?.employees ?? [];

    expect(activeList.every((e) => e.status === "active")).toBe(true);
    // 0007 將 emp-009／011／013 標記為離職，因此兩者筆數必須不同。
    expect(allList.length).toBeGreaterThan(activeList.length);
    expect(allList.some((e) => e.status === "inactive")).toBe(true);
    expect(allList.find((e) => e.id === "emp-011")?.terminationDate).toBeTruthy();
  });

  it("employee_no 重複回 409 並附友善訊息", async () => {
    const dup = await call("/api/admin/employees", adminJson("POST", newEmployeeBody({
      email: "crud.duplicate@demo.local",
    })));
    expect(dup.response.status).toBe(409);
    expect(dup.body.error?.message).toContain("E900");
  });

  it("job_type_id 無效回 422", async () => {
    const invalid = await call("/api/admin/employees", adminJson("POST", newEmployeeBody({
      employeeNo: "E901",
      email: "crud.badjobtype@demo.local",
      jobTypeId: "jt-not-exist",
    })));
    expect(invalid.response.status).toBe(422);
  });

  it("admin 可更新員工資料", async () => {
    const created = await call<{ employee: EmployeeRecord }>("/api/admin/employees", adminJson("POST", newEmployeeBody({
      employeeNo: "E902",
      email: "crud.update@demo.local",
    })));
    expect(created.response.status).toBe(201);
    const id = created.body.data?.employee.id ?? "";

    const updated = await call<{ employee: EmployeeRecord }>(`/api/admin/employees/${id}`, adminJson("PATCH", newEmployeeBody({
      employeeNo: "E902",
      email: "crud.update@demo.local",
      name: "測試更新後",
      grade: "G2",
      salary: 50000,
    })));
    expect(updated.response.status).toBe(200);
    expect(updated.body.data?.employee).toMatchObject({
      name: "測試更新後",
      grade: "G2",
      salary: 50000,
    });
  });

  it("更新不存在的員工回 404", async () => {
    const missing = await call("/api/admin/employees/emp-not-exist", adminJson("PATCH", newEmployeeBody({
      employeeNo: "E999",
      email: "crud.missing@demo.local",
    })));
    expect(missing.response.status).toBe(404);
  });

  it("設為離職須填離職日，復職時離職日一律清空", async () => {
    const created = await call<{ employee: EmployeeRecord }>("/api/admin/employees", adminJson("POST", newEmployeeBody({
      employeeNo: "E903",
      email: "crud.terminate@demo.local",
    })));
    const id = created.body.data?.employee.id ?? "";

    const missingDate = await call(`/api/admin/employees/${id}`, adminJson("PATCH", newEmployeeBody({
      employeeNo: "E903",
      email: "crud.terminate@demo.local",
      status: "inactive",
    })));
    expect(missingDate.response.status).toBe(422);

    const terminated = await call<{ employee: EmployeeRecord }>(`/api/admin/employees/${id}`, adminJson("PATCH", newEmployeeBody({
      employeeNo: "E903",
      email: "crud.terminate@demo.local",
      status: "inactive",
      terminationDate: "2026-06-30",
    })));
    expect(terminated.response.status).toBe(200);
    expect(terminated.body.data?.employee).toMatchObject({
      status: "inactive",
      terminationDate: "2026-06-30",
    });

    // 復職：狀態改回 active 時，即使請求仍夾帶舊離職日也應被伺服器清空，不可信任呼叫端傳入值。
    const reinstated = await call<{ employee: EmployeeRecord }>(`/api/admin/employees/${id}`, adminJson("PATCH", newEmployeeBody({
      employeeNo: "E903",
      email: "crud.terminate@demo.local",
      status: "active",
      terminationDate: "2026-06-30",
    })));
    expect(reinstated.response.status).toBe(200);
    expect(reinstated.body.data?.employee.status).toBe("active");
    expect(reinstated.body.data?.employee.terminationDate).toBeNull();

    const row = await env.DB.prepare(
      "SELECT termination_date AS terminationDate FROM employees WHERE id = ?",
    ).bind(id).first<{ terminationDate: string | null }>();
    expect(row?.terminationDate).toBeNull();
  });

  it("employee 帳號呼叫建立／更新皆得 403", async () => {
    const created = await call("/api/admin/employees", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employeeCookie },
      body: JSON.stringify(newEmployeeBody({ employeeNo: "E904", email: "crud.forbidden@demo.local" })),
    });
    expect(created.response.status).toBe(403);

    const updated = await call("/api/admin/employees/emp-002", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: employeeCookie },
      body: JSON.stringify(newEmployeeBody()),
    });
    expect(updated.response.status).toBe(403);
  });
});
