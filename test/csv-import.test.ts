import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { message: string; details?: unknown };
}

interface ImportSummary {
  imported: number;
  updated: number;
  skipped: number;
  errors: Array<{ row: number; message: string }>;
}

let adminCookie = "";
let employeeCookie = "";

async function call<T>(path: string, init?: RequestInit): Promise<{ response: Response; body: Envelope<T> }> {
  const response = await exports.default.fetch(`https://example.com${path}`, init);
  const body = await response.json<Envelope<T>>();
  return { response, body };
}

function adminCsv(csv: string): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ csv }),
  };
}

async function loginAndChange(email: string, newPassword: string): Promise<string> {
  const login = await call<{ user: { role: string } }>("/api/auth/login", {
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
  adminCookie = await loginAndChange("admin@demo.local", "AdminCsvImportChanged1234!");
  employeeCookie = await loginAndChange("chiahao.lin@demo.local", "EmployeeCsvImportChanged1234!");
});

describe("CSV 匯入：缺勤加班（POST /api/admin/reports/attendance/import）", () => {
  it("成功列新增、錯誤列各自記錄且不中斷整批，回應固定 200", async () => {
    // 標題順序刻意打亂，且開頭附 BOM，驗證「依標題名稱對應」與 BOM 去除。
    const csv =
      "﻿日期,缺勤時數,加班時數,員工編號,假別,備註\n" +
      '2020-01-15,4,2,E001,事假,"含逗號,的備註"\n' +
      "2020-01-16,1,1,E999,,\n" + // 員工編號不存在
      "2020/01/17,1,1,E002,,\n" + // 日期格式錯誤
      "2020-01-18,-1,0,E002,,\n"; // 缺勤時數為負

    const result = await call<ImportSummary>(
      "/api/admin/reports/attendance/import",
      adminCsv(csv),
    );
    expect(result.response.status).toBe(200);
    const summary = result.body.data;
    if (!summary) throw new Error("未回傳匯入結果。");
    expect(summary.imported).toBe(1);
    expect(summary.updated).toBe(0);
    expect(summary.skipped).toBe(3);
    expect(summary.errors).toHaveLength(3);
    expect(summary.errors.map((error) => error.row)).toEqual([3, 4, 5]);
    expect(summary.errors[0]?.message).toContain("E999");
    expect(summary.errors[1]?.message).toContain("YYYY-MM-DD");
    expect(summary.errors[2]?.message).toContain("缺勤時數");

    const row = await env.DB.prepare(`
      SELECT a.absence_hours AS absenceHours, a.overtime_hours AS overtimeHours,
             a.absence_type AS absenceType, a.source, a.notes
      FROM attendance a JOIN employees e ON e.id = a.employee_id
      WHERE e.employee_no = 'E001' AND a.attendance_date = '2020-01-15'
    `).first<{ absenceHours: number; overtimeHours: number; absenceType: string; source: string; notes: string }>();
    expect(row).toMatchObject({
      absenceHours: 4,
      overtimeHours: 2,
      absenceType: "事假",
      source: "csv",
      notes: "含逗號,的備註",
    });
  });

  it("同員工同日期重複匯入採更新，不新增第二列", async () => {
    const csv = "員工編號,日期,缺勤時數,加班時數,假別,備註\nE001,2020-01-15,10,5,病假,更新備註\n";
    const result = await call<ImportSummary>(
      "/api/admin/reports/attendance/import",
      adminCsv(csv),
    );
    expect(result.response.status).toBe(200);
    expect(result.body.data).toMatchObject({ imported: 0, updated: 1, skipped: 0, errors: [] });

    const rows = await env.DB.prepare(`
      SELECT a.absence_hours AS absenceHours, a.overtime_hours AS overtimeHours,
             a.absence_type AS absenceType, a.notes
      FROM attendance a JOIN employees e ON e.id = a.employee_id
      WHERE e.employee_no = 'E001' AND a.attendance_date = '2020-01-15'
    `).all<{ absenceHours: number; overtimeHours: number; absenceType: string; notes: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({
      absenceHours: 10,
      overtimeHours: 5,
      absenceType: "病假",
      notes: "更新備註",
    });
  });

  it("整體性失敗：缺少 csv 欄位或標題列缺欄位回 4xx", async () => {
    const missingField = await call("/api/admin/reports/attendance/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({}),
    });
    expect(missingField.response.status).toBe(400);

    const missingHeader = await call(
      "/api/admin/reports/attendance/import",
      adminCsv("員工編號,日期,缺勤時數,加班時數,假別\nE001,2020-01-01,1,1,\n"),
    );
    expect(missingHeader.response.status).toBe(400);
    expect(missingHeader.body.error?.message).toContain("備註");
  });

  it("employee 帳號呼叫得 403", async () => {
    const result = await call("/api/admin/reports/attendance/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employeeCookie },
      body: JSON.stringify({ csv: "員工編號,日期,缺勤時數,加班時數,假別,備註\nE001,2020-01-01,1,1,,\n" }),
    });
    expect(result.response.status).toBe(403);
  });
});

describe("CSV 匯入：員工主檔（POST /api/admin/employees/import）", () => {
  it("成功新增、職務類型或 Email 有誤的列各自記錄錯誤，回應固定 200", async () => {
    const csv =
      "姓名,Email,部門,職等,職稱,職務類型,到職日,薪資,員工編號\n" +
      "測試新人,csv.newhire@demo.local,人資行政部,G1,測試專員,內勤,2024-05-01,45000,E900\n" +
      "測試錯誤,csv.badjobtype@demo.local,人資行政部,G1,測試專員,不存在的職務,2024-05-01,45000,E901\n" +
      "測試重複,csv.newhire@demo.local,人資行政部,G1,測試專員,內勤,2024-05-02,40000,E902\n" +
      ",csv.blank@demo.local,人資行政部,G1,測試專員,內勤,2024-05-01,40000,E903\n" +
      "測試薪資,csv.badsalary@demo.local,人資行政部,G1,測試專員,內勤,2024-05-01,abc,E904\n" +
      "測試無薪資,csv.nosalary@demo.local,人資行政部,G1,測試專員,內勤,2024-05-03,,E905\n";

    const result = await call<ImportSummary>("/api/admin/employees/import", adminCsv(csv));
    expect(result.response.status).toBe(200);
    const summary = result.body.data;
    if (!summary) throw new Error("未回傳匯入結果。");
    expect(summary.imported).toBe(2);
    expect(summary.updated).toBe(0);
    expect(summary.skipped).toBe(4);
    expect(summary.errors).toHaveLength(4);
    expect(summary.errors.map((error) => error.row)).toEqual([3, 4, 5, 6]);
    expect(summary.errors[0]?.message).toContain("不存在的職務");
    expect(summary.errors[1]?.message).toContain("E900");
    expect(summary.errors[2]?.message).toContain("姓名");
    expect(summary.errors[3]?.message).toContain("薪資");

    const created = await env.DB.prepare(`
      SELECT e.name, e.email, e.department, e.grade, e.title, e.hire_date AS hireDate,
             e.salary, jt.name AS jobType
      FROM employees e JOIN job_types jt ON jt.id = e.job_type_id
      WHERE e.employee_no = 'E900'
    `).first<{ name: string; email: string; department: string; grade: string; title: string; hireDate: string; salary: number; jobType: string }>();
    expect(created).toMatchObject({
      name: "測試新人",
      email: "csv.newhire@demo.local",
      department: "人資行政部",
      grade: "G1",
      title: "測試專員",
      hireDate: "2024-05-01",
      salary: 45000,
      jobType: "內勤",
    });

    const noSalary = await env.DB.prepare(
      "SELECT salary FROM employees WHERE employee_no = 'E905'",
    ).first<{ salary: number | null }>();
    expect(noSalary?.salary).toBeNull();
  });

  it("同員工編號重複匯入採更新，不新增第二筆員工", async () => {
    const csv = "員工編號,姓名,Email,部門,職等,職稱,職務類型,到職日,薪資\n"
      + "E900,測試新人更新,csv.newhire@demo.local,人資行政部,G2,資深測試專員,診所線,2024-05-01,50000\n";
    const result = await call<ImportSummary>("/api/admin/employees/import", adminCsv(csv));
    expect(result.response.status).toBe(200);
    expect(result.body.data).toMatchObject({ imported: 0, updated: 1, skipped: 0, errors: [] });

    const rows = await env.DB.prepare(
      "SELECT id FROM employees WHERE employee_no = 'E900'",
    ).all<{ id: string }>();
    expect(rows.results).toHaveLength(1);

    const updated = await env.DB.prepare(`
      SELECT e.name, e.grade, e.title, e.salary, jt.name AS jobType
      FROM employees e JOIN job_types jt ON jt.id = e.job_type_id
      WHERE e.employee_no = 'E900'
    `).first<{ name: string; grade: string; title: string; salary: number; jobType: string }>();
    expect(updated).toMatchObject({
      name: "測試新人更新",
      grade: "G2",
      title: "資深測試專員",
      salary: 50000,
      jobType: "診所線",
    });
  });

  it("整體性失敗：缺少 csv 欄位或標題列缺欄位回 4xx", async () => {
    const missingField = await call("/api/admin/employees/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({}),
    });
    expect(missingField.response.status).toBe(400);

    const missingHeader = await call(
      "/api/admin/employees/import",
      adminCsv("員工編號,姓名,Email,部門,職等,職稱,職務類型,到職日\nE999,測試,a@demo.local,部門,G1,職稱,內勤,2024-01-01\n"),
    );
    expect(missingHeader.response.status).toBe(400);
    expect(missingHeader.body.error?.message).toContain("薪資");
  });

  it("employee 帳號呼叫得 403", async () => {
    const result = await call("/api/admin/employees/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employeeCookie },
      body: JSON.stringify({
        csv: "員工編號,姓名,Email,部門,職等,職稱,職務類型,到職日,薪資\nE999,測試,a@demo.local,部門,G1,職稱,內勤,2024-01-01,\n",
      }),
    });
    expect(result.response.status).toBe(403);
  });
});
