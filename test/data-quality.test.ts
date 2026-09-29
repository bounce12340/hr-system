import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { dataQualityItems, type DataQualityItem } from "../src/server/data-quality";
import { ApiError } from "../src/server/http";
import { strictIsoDate } from "../src/server/onboarding-conversion";

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { message: string };
}

interface DataQualityPayload {
  counts: {
    total: number;
    birthDate: number;
    department: number;
    unlinkedAccount: number;
  };
  items: DataQualityItem[];
}

async function call<T>(path: string, init?: RequestInit) {
  const response = await exports.default.fetch(`https://example.com${path}`, init);
  return { response, body: await response.json<Envelope<T>>() };
}

let adminCookie = "";
let employeeCookie = "";

async function login(email: string): Promise<string> {
  await env.DB.prepare("UPDATE users SET must_change_password = 0 WHERE email = ?").bind(email).run();
  const result = await call("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Demo1234!" }),
  });
  expect(result.response.status).toBe(200);
  return result.response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

beforeAll(async () => {
  adminCookie = await login("admin@demo.local");
  employeeCookie = await login("chiahao.lin@demo.local");
});

describe("資料待補清單", () => {
  it("只列出缺生日、空白部門與未連結帳號，正常員工不出現，且 dueDate 為 null", async () => {
    const jobType = await env.DB.prepare("SELECT id FROM job_types LIMIT 1").first<{ id: string }>();
    expect(jobType?.id).toBeTruthy();
    const suffix = crypto.randomUUID().slice(0, 8);
    const missingBirthId = `dq-birth-${suffix}`;
    const blankDepartmentId = `dq-dept-${suffix}`;
    const normalId = `dq-ok-${suffix}`;
    const unlinkedUserId = `dq-user-${suffix}`;
    const archivedUserId = `dq-archived-${suffix}`;

    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO employees (
          id, employee_no, name, email, department, grade, title, job_type_id, hire_date, birth_date, status
        ) VALUES (?, ?, '缺生日', ?, '資料品質部', 'G1', '測試', ?, '2020-01-15', NULL, 'active')
      `).bind(missingBirthId, `DQB-${suffix}`, `dq-birth-${suffix}@example.com`, jobType?.id),
      env.DB.prepare(`
        INSERT INTO employees (
          id, employee_no, name, email, department, grade, title, job_type_id, hire_date, birth_date, status
        ) VALUES (?, ?, '空白部門', ?, '   ', 'G1', '測試', ?, '2020-01-15', '1990-01-01', 'active')
      `).bind(blankDepartmentId, `DQD-${suffix}`, `dq-dept-${suffix}@example.com`, jobType?.id),
      env.DB.prepare(`
        INSERT INTO employees (
          id, employee_no, name, email, department, grade, title, job_type_id, hire_date, birth_date, status
        ) VALUES (?, ?, '正常員工', ?, '資料品質部', 'G1', '測試', ?, '2020-01-15', '1990-01-01', 'active')
      `).bind(normalId, `DQN-${suffix}`, `dq-ok-${suffix}@example.com`, jobType?.id),
      env.DB.prepare(`
        INSERT INTO users (
          id, employee_id, email, password_hash, password_salt, password_iterations, role, must_change_password, active
        ) VALUES (?, NULL, ?, 'hash', 'salt', 100000, 'employee', 1, 1)
      `).bind(unlinkedUserId, `dq-user-${suffix}@example.com`),
      env.DB.prepare(`
        INSERT INTO users (
          id, employee_id, email, password_hash, password_salt, password_iterations, role,
          must_change_password, active, archived_at
        ) VALUES (?, NULL, ?, 'hash', 'salt', 100000, 'employee', 1, 0, '2026-01-01T00:00:00.000Z')
      `).bind(archivedUserId, `dq-archived-${suffix}@example.com`),
    ]);

    const listed = await call<DataQualityPayload>("/api/admin/data-quality", {
      headers: { Cookie: adminCookie },
    });
    expect(listed.response.status).toBe(200);
    expect(listed.body.ok).toBe(true);
    const items = listed.body.data?.items ?? [];
    const ids = items.map((item) => item.entityId);
    expect(ids).toContain(missingBirthId);
    expect(ids).toContain(blankDepartmentId);
    expect(ids).toContain(unlinkedUserId);
    expect(ids).not.toContain(normalId);
    expect(ids).not.toContain(archivedUserId);

    const birth = items.find((item) => item.entityId === missingBirthId);
    expect(birth).toMatchObject({
      id: `employee:${missingBirthId}:birth_date`,
      entityType: "employee",
      field: "birth_date",
      reason: "missing_birth_date",
      nextAction: { tab: "employees" },
      dueDate: null,
    });
    expect(birth?.impact).toContain("健檢頻率");

    const department = items.find((item) => item.entityId === blankDepartmentId);
    expect(department).toMatchObject({
      id: `employee:${blankDepartmentId}:department`,
      field: "department",
      nextAction: { tab: "employees" },
      dueDate: null,
    });
    expect(department?.impact).toContain("部門");

    const account = items.find((item) => item.entityId === unlinkedUserId);
    expect(account).toMatchObject({
      id: `user:${unlinkedUserId}:employee_id`,
      entityType: "user",
      field: "employee_id",
      nextAction: { tab: "settings" },
      dueDate: null,
    });
    expect(account?.impact).toContain("403");
    expect(JSON.stringify(listed.body.data)).not.toContain("overdue");
    expect(items.every((item) => item.dueDate === null)).toBe(true);
    expect(listed.body.data?.counts.total).toBe(items.length);
  });

  it("員工 token 403，未登入 401，空缺口不是錯誤", async () => {
    const employee = await call("/api/admin/data-quality", { headers: { Cookie: employeeCookie } });
    expect(employee.response.status).toBe(403);

    const anonymous = await call("/api/admin/data-quality");
    expect(anonymous.response.status).toBe(401);

    const admin = await call<DataQualityPayload>("/api/admin/data-quality", {
      headers: { Cookie: adminCookie },
    });
    expect(admin.response.status).toBe(200);
    expect(Array.isArray(admin.body.data?.items)).toBe(true);
  });
});

describe("既有到職日驗證", () => {
  it("strictIsoDate 拒絕非法日期，不把缺資料標成逾期", () => {
    for (const value of ["", "2026-02-30", "2026-13-01", "not-a-date"]) {
      expect(() => strictIsoDate(value, "到職日")).toThrow(ApiError);
    }
    expect(strictIsoDate("2024-02-29", "到職日")).toBe("2024-02-29");
  });
});

describe("資料待補純函式", () => {
  it("不把完整資料或封存帳號列成缺口", () => {
    const items = dataQualityItems(
      [
        { id: "e-ok", birthDate: "1990-01-01", department: "診所事業部" },
        { id: "e-blank-birth", birthDate: "  ", department: "診所事業部" },
      ],
      [],
    );
    expect(items.map((item) => item.id)).toEqual(["employee:e-blank-birth:birth_date"]);
    expect(items[0]?.dueDate).toBeNull();
  });
});
