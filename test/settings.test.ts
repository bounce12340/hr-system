import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { message: string; details?: unknown };
}

interface PublicSetting {
  key: string;
  value: unknown;
  valueType: "string" | "number" | "boolean" | "json";
  description: string;
}

interface JobType {
  id: string;
  name: string;
  requiredLevel: number;
  active: number;
  employeeCount: number;
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

function employeeJson(method: string, body: object): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json", Cookie: employeeCookie },
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
  adminCookie = await loginAndChange("admin@demo.local", "AdminSettingsChanged1234!");
  employeeCookie = await loginAndChange("chihming.chang@demo.local", "EmployeeSettingsChanged1234!");
});

describe("系統設定統一入口（GET／PATCH /api/admin/settings）", () => {
  it("GET 回傳所有設定項，並依 valueType 轉換 value 型別", async () => {
    const result = await call<{ settings: PublicSetting[] }>(
      "/api/admin/settings",
      { headers: { Cookie: adminCookie } },
    );
    expect(result.response.status).toBe(200);
    const settings = result.body.data?.settings ?? [];

    // value 刻意回傳資料庫原始字串（不在後端轉型），前端依 valueType 自行轉成
    // number／boolean 渲染（見 src/client/pages/SettingsAdminPages.tsx 的
    // parseSettingValue／src/client/types.ts 的 SettingItem.value: string）。
    const reminderDays = settings.find((s) => s.key === "certification_reminder_days");
    expect(reminderDays?.valueType).toBe("number");
    expect(reminderDays?.value).toBe("60");

    const approval = settings.find((s) => s.key === "elective_enrollment_requires_approval");
    expect(approval?.valueType).toBe("boolean");
    expect(approval?.value).toBe("false");

    const timezone = settings.find((s) => s.key === "timezone");
    expect(timezone?.valueType).toBe("string");
    expect(timezone?.value).toBe("Asia/Taipei");

    for (const item of settings) {
      expect(item).toHaveProperty("description");
      expect(typeof item.value).toBe("string");
    }
  });

  it("PATCH 可批次更新多筆，且與既有 training-settings／probation-settings 端點共存不打架", async () => {
    const patched = await call<{ settings: PublicSetting[] }>(
      "/api/admin/settings",
      adminJson("PATCH", {
        updates: [
          { key: "certification_reminder_days", value: 45 },
          { key: "probation_reminder_days", value: 20 },
        ],
      }),
    );
    expect(patched.response.status).toBe(200);
    const patchedSettings = patched.body.data?.settings ?? [];
    expect(patchedSettings.find((s) => s.key === "certification_reminder_days")?.value).toBe("45");
    expect(patchedSettings.find((s) => s.key === "probation_reminder_days")?.value).toBe("20");

    // 舊端點讀到同一份底層資料，必須看得到透過新端點寫入的值。
    const training = await call<{ settings: { certificationReminderDays: number } }>(
      "/api/admin/training-settings",
      { headers: { Cookie: adminCookie } },
    );
    expect(training.body.data?.settings.certificationReminderDays).toBe(45);

    // 反過來：透過舊端點寫入，新端點也要立刻看得到，證明兩者是同一份資料的不同入口。
    const viaOldEndpoint = await call(
      "/api/admin/recruitment/probation-settings",
      adminJson("PATCH", { reminderDays: 33 }),
    );
    expect(viaOldEndpoint.response.status).toBe(200);
    const afterOldEndpoint = await call<{ settings: PublicSetting[] }>(
      "/api/admin/settings",
      { headers: { Cookie: adminCookie } },
    );
    expect(afterOldEndpoint.body.data?.settings.find((s) => s.key === "probation_reminder_days")?.value).toBe("33");
  });

  it("更新不存在的設定 key 回 404", async () => {
    const result = await call(
      "/api/admin/settings",
      adminJson("PATCH", { updates: [{ key: "not_a_real_setting", value: "x" }] }),
    );
    expect(result.response.status).toBe(404);
  });

  it("value 型別與 valueType 不符回 422", async () => {
    const result = await call(
      "/api/admin/settings",
      adminJson("PATCH", { updates: [{ key: "certification_reminder_days", value: "六十" }] }),
    );
    expect(result.response.status).toBe(422);
  });

  it("updates 為空陣列回 422", async () => {
    const result = await call("/api/admin/settings", adminJson("PATCH", { updates: [] }));
    expect(result.response.status).toBe(422);
  });

  it("employee 帳號呼叫 GET／PATCH 皆得 403", async () => {
    const get = await call("/api/admin/settings", { headers: { Cookie: employeeCookie } });
    expect(get.response.status).toBe(403);

    const patch = await call(
      "/api/admin/settings",
      employeeJson("PATCH", { updates: [{ key: "timezone", value: "UTC" }] }),
    );
    expect(patch.response.status).toBe(403);
  });
});

describe("職務類型管理（/api/admin/job-types）", () => {
  it("GET 回傳職務類型清單，含必修級距與使用人數", async () => {
    const result = await call<{ jobTypes: JobType[] }>(
      "/api/admin/job-types",
      { headers: { Cookie: adminCookie } },
    );
    expect(result.response.status).toBe(200);
    const office = result.body.data?.jobTypes.find((jt) => jt.id === "jt-office");
    expect(office).toMatchObject({ name: "內勤", requiredLevel: 1 });
    expect(office?.employeeCount).toBeGreaterThan(0);
  });

  it("POST 新增、PATCH 更新，名稱重複回 409", async () => {
    const created = await call<{ jobType: JobType }>(
      "/api/admin/job-types",
      adminJson("POST", { name: "測試職務A", requiredLevel: 2 }),
    );
    expect(created.response.status).toBe(201);
    expect(created.body.data?.jobType).toMatchObject({
      name: "測試職務A",
      requiredLevel: 2,
      active: 1,
      employeeCount: 0,
    });
    const id = created.body.data?.jobType.id ?? "";

    const updated = await call<{ jobType: JobType }>(
      `/api/admin/job-types/${id}`,
      adminJson("PATCH", { name: "測試職務A（改名）", requiredLevel: 3, active: false }),
    );
    expect(updated.response.status).toBe(200);
    expect(updated.body.data?.jobType).toMatchObject({
      name: "測試職務A（改名）",
      requiredLevel: 3,
      active: 0,
    });

    const duplicate = await call(
      "/api/admin/job-types",
      adminJson("POST", { name: "測試職務A（改名）", requiredLevel: 1 }),
    );
    expect(duplicate.response.status).toBe(409);
  });

  it("requiredLevel 超出 1～3 範圍回 422", async () => {
    const result = await call(
      "/api/admin/job-types",
      adminJson("POST", { name: "測試職務越界", requiredLevel: 5 }),
    );
    expect(result.response.status).toBe(422);
  });

  it("刪除仍有員工使用的職務類型回 409 並附友善訊息說明人數", async () => {
    const result = await call("/api/admin/job-types/jt-office", adminJson("DELETE", {}));
    expect(result.response.status).toBe(409);
    expect(result.body.error?.message).toMatch(/位員工使用中/);
  });

  it("刪除沒有員工使用的職務類型可成功", async () => {
    const created = await call<{ jobType: JobType }>(
      "/api/admin/job-types",
      adminJson("POST", { name: "測試職務可刪除", requiredLevel: 1 }),
    );
    const id = created.body.data?.jobType.id ?? "";

    const deleted = await call(`/api/admin/job-types/${id}`, adminJson("DELETE", {}));
    expect(deleted.response.status).toBe(200);

    const gone = await call(`/api/admin/job-types/${id}`, adminJson("PATCH", { name: "x", requiredLevel: 1 }));
    expect(gone.response.status).toBe(404);
  });

  it("刪除不存在的職務類型回 404", async () => {
    const result = await call("/api/admin/job-types/jt-not-exist", adminJson("DELETE", {}));
    expect(result.response.status).toBe(404);
  });

  it("employee 帳號呼叫 GET／POST 皆得 403", async () => {
    const get = await call("/api/admin/job-types", { headers: { Cookie: employeeCookie } });
    expect(get.response.status).toBe(403);
    const post = await call(
      "/api/admin/job-types",
      employeeJson("POST", { name: "偷改", requiredLevel: 1 }),
    );
    expect(post.response.status).toBe(403);
  });
});
