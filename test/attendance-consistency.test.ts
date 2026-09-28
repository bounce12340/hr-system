import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

interface Envelope<T> { ok: boolean; data?: T; error?: { message: string } }
interface RecordResult { record: { id: string; employeeId: string; attendanceDate: string; absenceHours: number; source: string; notes: string } }
interface ImportSummary { imported: number; updated: number; skipped: number; errors: unknown[] }

let adminCookie = "";
async function call<T>(path: string, init?: RequestInit): Promise<{ response: Response; body: Envelope<T> }> {
  const response = await exports.default.fetch(`https://example.com${path}`, init);
  return { response, body: await response.json<Envelope<T>>() };
}
function adminJson(method: string, body: object): RequestInit {
  return { method, headers: { "Content-Type": "application/json", Cookie: adminCookie }, body: JSON.stringify(body) };
}
async function loginAndChange(): Promise<string> {
  const login = await call("/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@demo.local", password: "Demo1234!" }),
  });
  expect(login.response.status).toBe(200);
  const cookie = login.response.headers.get("set-cookie")?.split(";")[0] ?? "";
  const changed = await call("/api/auth/change-password", {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ currentPassword: "Demo1234!", newPassword: "AdminAttendanceConsistency1234!" }),
  });
  expect(changed.response.status).toBe(200);
  return cookie;
}
beforeAll(async () => { adminCookie = await loginAndChange(); });

// 用固定歷史日期避開動態 seed；所有寫入由唯一鍵而非「先查再寫」協調。
describe("attendance uniqueness and atomic upsert", () => {
  it("同日重送更新原 ID，並讓 CSV 更新手動資料", async () => {
    const path = "/api/admin/reports/attendance/records";
    const first = await call<RecordResult>(path, adminJson("POST", {
      employeeId: "emp-002", attendanceDate: "2018-01-10", absenceHours: 2, notes: "manual first",
    }));
    expect(first.response.status).toBe(201);
    const id = first.body.data!.record.id;
    const second = await call<RecordResult>(path, adminJson("POST", {
      employeeId: "emp-002", attendanceDate: "2018-01-10", absenceHours: 7, notes: "manual repeat",
    }));
    expect(second.response.status).toBe(200);
    expect(second.body.data?.record).toMatchObject({ id, absenceHours: 7, source: "manual", notes: "manual repeat" });

    const imported = await call<ImportSummary>("/api/admin/reports/attendance/import", adminJson("POST", {
      csv: "員工編號,日期,缺勤時數,加班時數,假別,備註\nE002,2018-01-10,5,1,病假,csv update\n",
    }));
    expect(imported.response.status).toBe(200);
    expect(imported.body.data).toMatchObject({ imported: 0, updated: 1, skipped: 0 });
    const row = await env.DB.prepare(
      "SELECT id, absence_hours AS absenceHours, source, notes FROM attendance WHERE employee_id = 'emp-002' AND attendance_date = '2018-01-10'",
    ).first<{ id: string; absenceHours: number; source: string; notes: string }>();
    expect(row).toEqual({ id, absenceHours: 5, source: "csv", notes: "csv update" });
  });

  it("CSV 新增後手動重送仍更新相同一筆且回報 updated", async () => {
    const imported = await call<ImportSummary>("/api/admin/reports/attendance/import", adminJson("POST", {
      csv: "員工編號,日期,缺勤時數,加班時數,假別,備註\nE004,2018-01-11,3,0,,csv first\n",
    }));
    expect(imported.body.data).toMatchObject({ imported: 1, updated: 0 });
    const before = await env.DB.prepare(
      "SELECT id FROM attendance WHERE employee_id = 'emp-004' AND attendance_date = '2018-01-11'",
    ).first<{ id: string }>();
    const manual = await call<RecordResult>("/api/admin/reports/attendance/records", adminJson("POST", {
      employeeId: "emp-004", attendanceDate: "2018-01-11", absenceHours: 9, notes: "manual overwrites csv",
    }));
    expect(manual.response.status).toBe(200);
    expect(manual.body.data?.record).toMatchObject({ id: before?.id, absenceHours: 9, source: "manual" });
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM attendance WHERE employee_id = 'emp-004' AND attendance_date = '2018-01-11'",
    ).first<{ count: number }>();
    expect(rows?.count).toBe(1);
  });

  it("兩個同日併發手動新增最終只有一筆；一個新增、一個更新", async () => {
    const path = "/api/admin/reports/attendance/records";
    const create = (hours: number) => call<RecordResult>(path, adminJson("POST", {
      employeeId: "emp-006", attendanceDate: "2018-01-12", absenceHours: hours, notes: `parallel-${hours}`,
    }));
    const [a, b] = await Promise.all([create(2), create(6)]);
    expect([a.response.status, b.response.status].sort()).toEqual([200, 201]);
    expect(a.body.data?.record.id).toBe(b.body.data?.record.id);
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM attendance WHERE employee_id = 'emp-006' AND attendance_date = '2018-01-12'",
    ).first<{ count: number }>();
    expect(rows?.count).toBe(1);
  });
});
