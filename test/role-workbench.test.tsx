import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { render } from "preact-render-to-string";
import { RoleWorkbench } from "../src/client/components/RoleWorkbench";
import {
  certificationBucket,
  sessionBucket,
  taipeiCalendar,
  taipeiToday,
  workbenchSummary,
} from "../src/shared/workbench";

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { message: string };
}

interface WorkbenchItem {
  id: string;
  source: string;
  dueDate: string | null;
  bucket: string;
  target: string;
  title: string;
}

interface WorkbenchData {
  today: string;
  weekStart: string;
  weekEnd: string;
  items: WorkbenchItem[];
  sources: Record<string, { status: string; itemCount: number }>;
}

let adminCookie = "";
let employeeACookie = "";
let employeeBCookie = "";

async function call<T>(path: string, init?: RequestInit): Promise<{
  response: Response;
  body: Envelope<T>;
}> {
  const response = await exports.default.fetch(`https://example.com${path}`, init);
  return { response, body: await response.json<Envelope<T>>() };
}

async function login(email: string, password: string): Promise<string> {
  const result = await call("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(result.response.status).toBe(200);
  return result.response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function loginAndChange(email: string, newPassword: string): Promise<string> {
  const cookie = await login(email, "Demo1234!");
  const changed = await call("/api/auth/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ currentPassword: "Demo1234!", newPassword }),
  });
  expect(changed.response.status).toBe(200);
  return cookie;
}

beforeAll(async () => {
  adminCookie = await loginAndChange("admin@demo.local", "AdminWorkbench1234!");
  employeeACookie = await loginAndChange("chiahao.lin@demo.local", "EmployeeAWorkbench1234!");
  employeeBCookie = await loginAndChange("yating.chen@demo.local", "EmployeeBWorkbench1234!");
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE candidate_applications SET status = 'hired' WHERE id = 'app-cand-01'
    `),
    env.DB.prepare(`
      INSERT INTO application_onboarding_checklist (
        id, application_id, onboarding_item_id, completed, completed_at, notes
      ) VALUES ('aoc-done', 'app-cand-02', 'obi-01', 1, '2026-09-01T00:00:00.000Z', '已完成')
    `),
    env.DB.prepare(`
      UPDATE course_sessions
      SET session_date = '2020-01-01', status = 'scheduled'
      WHERE id = 'cs-01'
    `),
    env.DB.prepare(`
      UPDATE course_sessions SET status = 'cancelled' WHERE id = 'cs-02'
    `),
    env.DB.prepare(`
      INSERT INTO employee_certifications (
        id, employee_id, certification_id, certificate_number, issued_at, expires_at, notes
      ) VALUES
        ('ec-today', 'emp-002', 'cert-gdp', 'TODAY', '2026-01-01', date('now'), '今天'),
        ('ec-forever', 'emp-002', 'cert-product', 'FOREVER', '2026-01-01', NULL, '永久'),
        ('ec-bad', 'emp-002', 'cert-hospital', 'BAD', '2026-01-01', 'not-a-date', '非法日期'),
        ('ec-b', 'emp-003', 'cert-gdp', 'OTHER', '2026-01-01', '2020-01-01', '他人逾期')
    `),
    env.DB.prepare(`
      UPDATE enrollments SET enrollment_status = 'cancelled'
      WHERE employee_id = 'emp-002' AND course_session_id = 'cs-06'
    `),
  ]);
});

describe("工作台日期規則", () => {
  it("台北 UTC 跨日與週界用固定 now，不依賴執行當下", () => {
    expect(taipeiToday(new Date("2026-09-28T16:30:00Z"))).toBe("2026-09-29");
    expect(taipeiToday(new Date("2026-09-28T15:30:00Z"))).toBe("2026-09-28");
    const sunday = taipeiCalendar(new Date("2026-09-27T15:30:00Z"));
    expect(sunday).toMatchObject({
      today: "2026-09-27",
      weekStart: "2026-09-21",
      weekEnd: "2026-09-27",
    });
    const monday = taipeiCalendar(new Date("2026-09-27T16:30:00Z"));
    expect(monday).toMatchObject({
      today: "2026-09-28",
      weekStart: "2026-09-28",
      weekEnd: "2026-10-04",
    });
  });

  it("證照今天、過去、週末、永久與非法日期分開", () => {
    expect(certificationBucket("2026-09-29", "2026-09-29")).toBe("today");
    expect(certificationBucket("2026-09-28", "2026-09-29")).toBe("overdue");
    expect(certificationBucket("2026-10-04", "2026-09-29")).toBe("this_week");
    expect(certificationBucket("2026-10-05", "2026-09-29")).toBe("later");
    expect(certificationBucket(null, "2026-09-29")).toBeNull();
    expect(certificationBucket("not-a-date", "2026-09-29")).toBe("unset");
  });

  it("過去場次是待核對，不是逾期；缺日期不排程", () => {
    expect(sessionBucket("2026-09-28", "2026-09-29")).toBe("past_unconfirmed");
    expect(sessionBucket("2026-09-29", "2026-09-29")).toBe("today");
    expect(sessionBucket(null, "2026-09-29")).toBe("unset");
  });
});

describe("工作台 API 範圍", () => {
  it("匿名 401，員工不可讀 admin，admin 不可讀 employee", async () => {
    const anonymous = await call("/api/admin/workbench");
    expect(anonymous.response.status).toBe(401);
    const employeeOnAdmin = await call("/api/admin/workbench", {
      headers: { Cookie: employeeACookie },
    });
    expect(employeeOnAdmin.response.status).toBe(403);
    const adminOnEmployee = await call("/api/employee/workbench", {
      headers: { Cookie: adminCookie },
    });
    expect(adminOnEmployee.response.status).toBe(403);
  });

  it("拒絕 query employeeId，且 A 看不到 B 或到職缺件", async () => {
    const spoofed = await call("/api/employee/workbench?employeeId=emp-003", {
      headers: { Cookie: employeeACookie },
    });
    expect(spoofed.response.status).toBe(400);
    const own = await call<WorkbenchData>("/api/employee/workbench", {
      headers: { Cookie: employeeACookie },
    });
    expect(own.response.status).toBe(200);
    const ids = own.body.data?.items.map((item) => item.id) ?? [];
    expect(ids.some((id) => id.includes("emp-003") || id === "certification_expiry:ec-b")).toBe(false);
    expect(own.body.data?.items.some((item) => item.source === "onboarding_missing")).toBe(false);
    expect(own.body.data?.items.some((item) => item.target !== "schedule" && item.target !== "certifications")).toBe(false);
    const other = await call<WorkbenchData>("/api/employee/workbench", {
      headers: { Cookie: employeeBCookie },
    });
    expect(other.body.data?.items.some((item) => item.id === "certification_expiry:ec-b")).toBe(true);
    expect(other.body.data?.items.some((item) => item.id === "certification_expiry:ec-today")).toBe(false);
  });

  it("admin 缺件無日期、完成與取消不進列，非法證照不算正常", async () => {
    const result = await call<WorkbenchData>("/api/admin/workbench", {
      headers: { Cookie: adminCookie },
    });
    expect(result.response.status).toBe(200);
    const items = result.body.data?.items ?? [];
    const missing = items.filter((item) => item.id.startsWith("onboarding_missing:app-cand-01:"));
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every((item) => item.dueDate === null && item.bucket === "unset")).toBe(true);
    expect(items.some((item) => item.id === "onboarding_missing:app-cand-02:obi-01")).toBe(false);
    expect(items.some((item) => item.id === "course_session:enr-cs02-emp-002")).toBe(false);
    expect(items.some((item) => item.id === "course_session:enr-cs06-emp-002")).toBe(false);
    expect(items.find((item) => item.id === "course_session:enr-cs01-emp-002")?.bucket).toBe("past_unconfirmed");
    expect(items.some((item) => item.id === "certification_expiry:ec-forever")).toBe(false);
    expect(items.find((item) => item.id === "certification_expiry:ec-bad")?.bucket).toBe("unset");
    expect(result.body.data?.sources.certification_expiry?.status).toBe("insufficient");
    expect(result.body.data?.sources.onboarding_missing?.status).toBe("insufficient");
  });
});

describe("工作台 UI 狀態", () => {
  const emptySources = {
    onboarding_missing: { status: "ok" as const, itemCount: 0, message: null },
    course_session: { status: "ok" as const, itemCount: 0, message: null },
    certification_expiry: { status: "ok" as const, itemCount: 0, message: null },
  };

  it("空集合、資料不足與載入失敗用不同文案", () => {
    expect(workbenchSummary({
      loading: false,
      error: null,
      items: [],
      sources: emptySources,
    }).headline).toBe("目前沒有工作台待辦。");
    expect(workbenchSummary({
      loading: false,
      error: null,
      items: [],
      sources: {
        ...emptySources,
        certification_expiry: { status: "insufficient", itemCount: 0, message: null },
      },
    }).headline).toContain("資料不足");
    const failed = workbenchSummary({
      loading: false,
      error: "讀取失敗",
      items: [],
      sources: null,
    }).headline;
    expect(failed).toContain("載入失敗");
    expect(failed).not.toContain("沒有工作台待辦");
  });

  it("SSR 初始狀態是讀取中，不用空陣列假裝成功", () => {
    const html = render(<RoleWorkbench endpoint="/api/admin/workbench" onOpenTarget={() => undefined} />);
    expect(html).toContain("工作台讀取中");
    expect(html).not.toContain("目前沒有工作台待辦。");
  });
});
