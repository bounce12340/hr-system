import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { message: string; details?: unknown };
}

interface EmployeeProfile {
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
  salary?: number;
}

let employeeCookie = "";

async function call<T>(path: string, init?: RequestInit): Promise<{ response: Response; body: Envelope<T> }> {
  const response = await exports.default.fetch(`https://example.com${path}`, init);
  return { response, body: await response.json<Envelope<T>>() };
}

function employeeJson(method: string, body: object): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json", Cookie: employeeCookie },
    body: JSON.stringify(body),
  };
}

async function login(email: string, password: string): Promise<{ response: Response; cookie: string }> {
  const response = await exports.default.fetch("https://example.com/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { response, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

async function loginAndChange(email: string, newPassword: string): Promise<string> {
  const first = await login(email, "Demo1234!");
  expect(first.response.status).toBe(200);
  const changed = await exports.default.fetch("https://example.com/api/auth/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: first.cookie },
    body: JSON.stringify({ currentPassword: "Demo1234!", newPassword }),
  });
  expect(changed.status).toBe(200);
  return first.cookie;
}

beforeAll(async () => {
  // emp-005（李佩珊）：本檔案專用測試對象，避免與其他測試檔的帳號互相干擾。
  employeeCookie = await loginAndChange("peishan.li@demo.local", "EmployeeProfileChanged1234!");
});

describe("員工個人資料（GET／PATCH /api/employee/profile）", () => {
  it("GET 回傳自己的完整資料，但不含 salary（規格 §三：薪資 admin-only）", async () => {
    const result = await call<{ employee: EmployeeProfile }>(
      "/api/employee/profile",
      { headers: { Cookie: employeeCookie } },
    );
    expect(result.response.status).toBe(200);
    const employee = result.body.data?.employee;
    expect(employee).toMatchObject({
      id: "emp-005",
      employeeNo: "E005",
      name: "李佩珊",
      email: "peishan.li@demo.local",
      department: "診所事業部",
      jobTypeId: "jt-clinic",
      jobType: "診所線",
      status: "active",
    });
    expect(employee).not.toHaveProperty("salary");
  });

  it("PATCH 可更新自己的 name／email，並反映在 GET 結果", async () => {
    const updated = await call<{ employee: EmployeeProfile }>(
      "/api/employee/profile",
      employeeJson("PATCH", { name: "李佩珊（已婚）", email: "peishan.new@demo.local" }),
    );
    expect(updated.response.status).toBe(200);
    expect(updated.body.data?.employee).toMatchObject({
      name: "李佩珊（已婚）",
      email: "peishan.new@demo.local",
    });

    const fetched = await call<{ employee: EmployeeProfile }>(
      "/api/employee/profile",
      { headers: { Cookie: employeeCookie } },
    );
    expect(fetched.body.data?.employee).toMatchObject({
      name: "李佩珊（已婚）",
      email: "peishan.new@demo.local",
    });
  });

  it("employees.email 與 users.email（登入帳號）分離：改聯絡信箱不影響登入", async () => {
    // 前一個測試已把 employees.email 改成 peishan.new@demo.local；
    // 若登入帳號被誤動，用舊的登入信箱應會失敗。
    const stillWorks = await login("peishan.li@demo.local", "EmployeeProfileChanged1234!");
    expect(stillWorks.response.status).toBe(200);

    const usersRow = await env.DB.prepare(
      "SELECT email FROM users WHERE employee_id = 'emp-005'",
    ).first<{ email: string }>();
    expect(usersRow?.email).toBe("peishan.li@demo.local");
  });

  it("PATCH 夾帶白名單以外欄位（department／salary／status／jobTypeId／employeeNo）一律不會被寫入", async () => {
    const before = await env.DB.prepare(
      `SELECT department, salary, status, job_type_id AS jobTypeId, employee_no AS employeeNo,
              grade, title, hire_date AS hireDate
       FROM employees WHERE id = 'emp-005'`,
    ).first<{
      department: string; salary: number; status: string; jobTypeId: string;
      employeeNo: string; grade: string; title: string; hireDate: string;
    }>();

    const attempted = await call<{ employee: EmployeeProfile }>(
      "/api/employee/profile",
      employeeJson("PATCH", {
        name: "李佩珊（嘗試越權）",
        email: "peishan.new@demo.local",
        department: "醫院事業部",
        salary: 999999,
        status: "inactive",
        jobTypeId: "jt-hospital",
        employeeNo: "E999",
        grade: "G9",
        title: "駭進去的職稱",
        hireDate: "2000-01-01",
      }),
    );
    expect(attempted.response.status).toBe(200);
    expect(attempted.body.data?.employee.name).toBe("李佩珊（嘗試越權）");

    const after = await env.DB.prepare(
      `SELECT department, salary, status, job_type_id AS jobTypeId, employee_no AS employeeNo,
              grade, title, hire_date AS hireDate
       FROM employees WHERE id = 'emp-005'`,
    ).first<{
      department: string; salary: number; status: string; jobTypeId: string;
      employeeNo: string; grade: string; title: string; hireDate: string;
    }>();
    expect(after).toEqual(before);
  });

  it("email 格式不正確回 422", async () => {
    const result = await call(
      "/api/employee/profile",
      employeeJson("PATCH", { name: "測試", email: "not-an-email" }),
    );
    expect(result.response.status).toBe(422);
  });

  it("email 與其他員工重複回 409", async () => {
    const result = await call(
      "/api/employee/profile",
      employeeJson("PATCH", { name: "測試", email: "chiahao.lin@demo.local" }),
    );
    expect(result.response.status).toBe(409);
  });

  it("未登入呼叫回 401", async () => {
    const result = await call("/api/employee/profile");
    expect(result.response.status).toBe(401);
  });
});
