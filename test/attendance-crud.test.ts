import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { message: string; details?: unknown };
}

interface AttendanceRecord {
  id: string;
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  department: string;
  grade: string;
  attendanceDate: string;
  absenceHours: number;
  overtimeHours: number;
  absenceType: string | null;
  source: "manual" | "csv";
  notes: string;
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

beforeAll(async () => {
  adminCookie = await loginAndChange("admin@demo.local", "AdminAttCrudChanged1234!");
  employeeCookie = await loginAndChange("chiahao.lin@demo.local", "EmployeeAttCrudChanged1234!");
});

// 以 2019 年的固定日期入資料：種子出缺勤全用 date('now', ...) 相對計算，落在最近 6 個月內，
// 用遠早於現在的固定日期可確保這裡新增的資料與種子、與其他測試檔互不干擾。
describe("出缺勤紀錄 CRUD（/api/admin/reports/attendance/records）", () => {
  it("admin 可手動建立單筆紀錄，source 固定為 manual", async () => {
    const created = await call<{ record: AttendanceRecord }>(
      "/api/admin/reports/attendance/records",
      adminJson("POST", {
        employeeId: "emp-002",
        attendanceDate: "2019-01-10",
        absenceHours: 4,
        overtimeHours: 2,
        absenceType: "事假",
        notes: "手動測試",
      }),
    );
    expect(created.response.status).toBe(201);
    expect(created.body.data?.record).toMatchObject({
      employeeId: "emp-002",
      employeeNo: "E002",
      attendanceDate: "2019-01-10",
      absenceHours: 4,
      overtimeHours: 2,
      absenceType: "事假",
      source: "manual",
      notes: "手動測試",
    });

    const row = await env.DB.prepare(
      "SELECT source FROM attendance WHERE employee_id = 'emp-002' AND attendance_date = '2019-01-10'",
    ).first<{ source: string }>();
    expect(row?.source).toBe("manual");
  });

  it("找不到員工回 422，日期格式錯誤回 422，時數為負回 422", async () => {
    const missingEmployee = await call("/api/admin/reports/attendance/records", adminJson("POST", {
      employeeId: "emp-not-exist",
      attendanceDate: "2019-01-11",
    }));
    expect(missingEmployee.response.status).toBe(422);

    const badDate = await call("/api/admin/reports/attendance/records", adminJson("POST", {
      employeeId: "emp-002",
      attendanceDate: "2019/01/11",
    }));
    expect(badDate.response.status).toBe(422);

    const negativeHours = await call("/api/admin/reports/attendance/records", adminJson("POST", {
      employeeId: "emp-002",
      attendanceDate: "2019-01-11",
      absenceHours: -1,
    }));
    expect(negativeHours.response.status).toBe(422);
  });

  it("同員工同日期已有紀錄時建立採更新（與 CSV 匯入行為一致），不新增第二列", async () => {
    const upserted = await call<{ record: AttendanceRecord }>(
      "/api/admin/reports/attendance/records",
      adminJson("POST", {
        employeeId: "emp-002",
        attendanceDate: "2019-01-10",
        absenceHours: 8,
        overtimeHours: 0,
        absenceType: "病假",
        notes: "更新為病假",
      }),
    );
    expect(upserted.response.status).toBe(200);
    expect(upserted.body.data?.record).toMatchObject({ absenceHours: 8, absenceType: "病假" });

    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM attendance WHERE employee_id = 'emp-002' AND attendance_date = '2019-01-10'",
    ).first<{ count: number }>();
    expect(rows?.count).toBe(1);
  });

  it("可更新單筆紀錄，異動至重複的員工＋日期組合回 409", async () => {
    const second = await call<{ record: AttendanceRecord }>(
      "/api/admin/reports/attendance/records",
      adminJson("POST", { employeeId: "emp-002", attendanceDate: "2019-01-12", absenceHours: 1, overtimeHours: 1 }),
    );
    expect(second.response.status).toBe(201);
    const secondId = second.body.data?.record.id ?? "";

    const updated = await call<{ record: AttendanceRecord }>(
      `/api/admin/reports/attendance/records/${secondId}`,
      adminJson("PATCH", {
        employeeId: "emp-002",
        attendanceDate: "2019-01-12",
        absenceHours: 3,
        overtimeHours: 0,
        notes: "已更新",
      }),
    );
    expect(updated.response.status).toBe(200);
    expect(updated.body.data?.record).toMatchObject({ absenceHours: 3, notes: "已更新" });

    const conflict = await call(
      `/api/admin/reports/attendance/records/${secondId}`,
      adminJson("PATCH", { employeeId: "emp-002", attendanceDate: "2019-01-10", absenceHours: 1, overtimeHours: 1 }),
    );
    expect(conflict.response.status).toBe(409);
  });

  it("可刪除單筆紀錄，刪除或更新不存在的 id 回 404", async () => {
    const created = await call<{ record: AttendanceRecord }>(
      "/api/admin/reports/attendance/records",
      adminJson("POST", { employeeId: "emp-004", attendanceDate: "2019-01-13", absenceHours: 2, overtimeHours: 0 }),
    );
    const id = created.body.data?.record.id ?? "";

    const deleted = await call(`/api/admin/reports/attendance/records/${id}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(deleted.response.status).toBe(200);

    const notFoundDelete = await call(`/api/admin/reports/attendance/records/${id}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(notFoundDelete.response.status).toBe(404);

    const notFoundUpdate = await call(
      `/api/admin/reports/attendance/records/${id}`,
      adminJson("PATCH", { employeeId: "emp-004", attendanceDate: "2019-01-13", absenceHours: 1, overtimeHours: 0 }),
    );
    expect(notFoundUpdate.response.status).toBe(404);
  });

  it("列表支援 department、grade、employeeId 與期間篩選", async () => {
    await call("/api/admin/reports/attendance/records", adminJson("POST", {
      employeeId: "emp-006", attendanceDate: "2019-02-05", absenceHours: 5, overtimeHours: 1,
    }));

    const byDept = await call<{ records: AttendanceRecord[] }>(
      `/api/admin/reports/attendance/records?startMonth=2019-01&endMonth=2019-02&department=${encodeURIComponent("診所事業部")}`,
      { headers: { Cookie: adminCookie } },
    );
    expect(byDept.response.status).toBe(200);
    expect(byDept.body.data?.records.length).toBeGreaterThan(0);
    expect(byDept.body.data?.records.every((record) => record.department === "診所事業部")).toBe(true);
    expect(byDept.body.data?.records.some((record) => record.employeeId === "emp-002")).toBe(true);
    expect(byDept.body.data?.records.some((record) => record.employeeId === "emp-006")).toBe(false);

    const byGrade = await call<{ records: AttendanceRecord[] }>(
      "/api/admin/reports/attendance/records?startMonth=2019-01&endMonth=2019-02&grade=G4",
      { headers: { Cookie: adminCookie } },
    );
    expect(byGrade.body.data?.records.length).toBeGreaterThan(0);
    expect(byGrade.body.data?.records.every((record) => record.grade === "G4")).toBe(true);
    expect(byGrade.body.data?.records.some((record) => record.employeeId === "emp-006")).toBe(true);

    const byEmployee = await call<{ records: AttendanceRecord[] }>(
      "/api/admin/reports/attendance/records?startMonth=2019-01&endMonth=2019-02&employeeId=emp-002",
      { headers: { Cookie: adminCookie } },
    );
    expect(byEmployee.body.data?.records.length).toBeGreaterThan(0);
    expect(byEmployee.body.data?.records.every((record) => record.employeeId === "emp-002")).toBe(true);

    const outOfRange = await call<{ records: AttendanceRecord[] }>(
      "/api/admin/reports/attendance/records?startMonth=2018-01&endMonth=2018-12&employeeId=emp-002",
      { headers: { Cookie: adminCookie } },
    );
    expect(outOfRange.body.data?.records.length).toBe(0);
  });

  it("employee 帳號呼叫任一端點皆得 403", async () => {
    const headers = { "Content-Type": "application/json", Cookie: employeeCookie };
    const list = await call("/api/admin/reports/attendance/records", { headers });
    expect(list.response.status).toBe(403);

    const create = await call("/api/admin/reports/attendance/records", {
      method: "POST",
      headers,
      body: JSON.stringify({ employeeId: "emp-002", attendanceDate: "2019-01-15" }),
    });
    expect(create.response.status).toBe(403);

    const update = await call("/api/admin/reports/attendance/records/whatever", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ employeeId: "emp-002", attendanceDate: "2019-01-15" }),
    });
    expect(update.response.status).toBe(403);

    const remove = await call("/api/admin/reports/attendance/records/whatever", {
      method: "DELETE",
      headers,
    });
    expect(remove.response.status).toBe(403);
  });
});
