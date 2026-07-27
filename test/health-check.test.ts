import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { message: string; details?: unknown };
}

interface HealthCheckItem {
  id: string;
  name: string;
  category: string;
  required: number;
  active: number;
  sortOrder: number;
}

interface ResultItem {
  id: string;
  itemId: string;
  itemName: string;
  category: string;
  itemActive: number;
  result: string;
  resultLabel: string;
  notes: string;
}

interface HealthCheckRecord {
  id: string;
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  department: string;
  checkDate: string;
  institution: string;
  notes: string;
  items: ResultItem[];
}

interface DueEmployee {
  employeeId: string;
  employeeNo: string;
  name: string;
  department: string;
  birthDate: string | null;
  hireDate: string;
  age: number | null;
  intervalMonths: number | null;
  lastCheckDate: string | null;
  nextDueDate: string | null;
  monthsUntilDue: number | null;
  status: string;
  statusLabel: string;
  dueBasis: string;
}

interface DueResponse {
  reminderMonths: number;
  windowMonths: number;
  employees: DueEmployee[];
}

interface EmployeeHealthResponse {
  reminderMonths: number;
  summary: DueEmployee | null;
  healthChecks: HealthCheckRecord[];
}

/** 一次拉到所有人（含最遠的 never／ok），用來驗證級距與四種狀態。 */
const FULL_WINDOW = 600;

let adminCookie = "";
let employeeCookie = ""; // emp-002／chiahao.lin，種子資料中屬 due_soon
let employeeCookie2 = ""; // emp-005／peishan.li，種子資料中屬 ok，用於驗證跨員工隔離

const ADMIN_ENDPOINTS = [
  "/api/admin/health-check-items",
  "/api/admin/health-checks",
  "/api/admin/health-checks/due",
];

async function call<T>(path: string, init?: RequestInit): Promise<{
  response: Response;
  body: Envelope<T>;
}> {
  const response = await exports.default.fetch(`https://example.com${path}`, init);
  return { response, body: await response.json<Envelope<T>>() };
}

function jsonRequest(method: string, cookie: string, body: object): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  };
}

function adminJson(method: string, body: object): RequestInit {
  return jsonRequest(method, adminCookie, body);
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

async function fetchDue(months?: number): Promise<DueResponse> {
  const query = months === undefined ? "" : `?months=${months}`;
  const result = await call<DueResponse>(`/api/admin/health-checks/due${query}`, {
    headers: { Cookie: adminCookie },
  });
  expect(result.response.status).toBe(200);
  return result.body.data as DueResponse;
}

function byEmployeeNo(employees: DueEmployee[]): Map<string, DueEmployee> {
  return new Map(employees.map((item) => [item.employeeNo, item]));
}

beforeAll(async () => {
  adminCookie = await loginAndChange("admin@demo.local", "AdminHcChanged1234!");
  employeeCookie = await loginAndChange("chiahao.lin@demo.local", "EmployeeHcChanged1234!");
  employeeCookie2 = await loginAndChange("peishan.li@demo.local", "EmployeeHcbChanged1234!");
});

describe("健檢頻率的年齡分級", () => {
  it("三個級距分別算出 5 年／3 年／1 年的間隔", async () => {
    const due = await fetchDue(FULL_WINDOW);
    const rows = byEmployeeNo(due.employees);

    // 種子資料（0011）刻意讓三個級距都有人，否則規則等於沒驗到。
    const young = rows.get("E004");
    const middle = rows.get("E001");
    const senior = rows.get("E003");
    expect(young?.age).toBeLessThan(40);
    expect(young?.intervalMonths).toBe(60);
    expect(middle?.age).toBeGreaterThanOrEqual(40);
    expect(middle?.age).toBeLessThan(65);
    expect(middle?.intervalMonths).toBe(36);
    expect(senior?.age).toBeGreaterThanOrEqual(65);
    expect(senior?.intervalMonths).toBe(12);

    // 全名單一致性：任何有生日的人，間隔都必須完全依級距推出。
    for (const row of due.employees) {
      if (row.age === null) {
        expect(row.intervalMonths).toBeNull();
        continue;
      }
      const expected = row.age < 40 ? 60 : row.age < 65 ? 36 : 12;
      expect(`${row.employeeNo}:${row.intervalMonths}`).toBe(`${row.employeeNo}:${expected}`);
    }

    // 三個級距各自至少 2 人（在職者），確保級距邊界不是靠單筆資料撐著。
    const brackets = { young: 0, middle: 0, senior: 0 };
    for (const row of due.employees) {
      if (row.age === null) continue;
      if (row.age < 40) brackets.young += 1;
      else if (row.age < 65) brackets.middle += 1;
      else brackets.senior += 1;
    }
    expect(brackets.young).toBeGreaterThanOrEqual(2);
    expect(brackets.middle).toBeGreaterThanOrEqual(2);
    expect(brackets.senior).toBeGreaterThanOrEqual(2);
  });

  it("下次應檢日 = 最後一次健檢日 + 目前年齡對應的間隔", async () => {
    const due = await fetchDue(FULL_WINDOW);
    for (const row of due.employees) {
      if (row.intervalMonths === null) continue;
      const basis = row.lastCheckDate ?? row.hireDate;
      const expected = new Date(`${basis}T00:00:00Z`);
      const day = expected.getUTCDate();
      expected.setUTCDate(1);
      expected.setUTCMonth(expected.getUTCMonth() + row.intervalMonths);
      // JS 與 SQLite 對「月底 + N 月」的溢位處理不同，只比對年月與日期上限。
      const lastDay = new Date(Date.UTC(expected.getUTCFullYear(), expected.getUTCMonth() + 1, 0))
        .getUTCDate();
      expected.setUTCDate(Math.min(day, lastDay));
      expect(row.nextDueDate?.slice(0, 7)).toBe(expected.toISOString().slice(0, 7));
      expect(row.dueBasis).toBe(row.lastCheckDate === null ? "hire_date" : "last_check");
    }
  });
});

describe("待健檢名單 GET /api/admin/health-checks/due", () => {
  it("四種狀態都出現，且最急迫者排在最前面", async () => {
    const due = await fetchDue(FULL_WINDOW);
    const statuses = new Set(due.employees.map((item) => item.status));
    expect(statuses.has("overdue")).toBe(true);
    expect(statuses.has("due_soon")).toBe(true);
    expect(statuses.has("ok")).toBe(true);
    expect(statuses.has("never")).toBe(true);

    // 排序：monthsUntilDue 由小到大（逾期為負數，故逾期最久者第一筆）；
    // 算不出來的（缺生日）一律墊底。
    let previous = Number.NEGATIVE_INFINITY;
    let seenNull = false;
    for (const row of due.employees) {
      if (row.monthsUntilDue === null) {
        seenNull = true;
        continue;
      }
      expect(seenNull).toBe(false);
      expect(row.monthsUntilDue).toBeGreaterThanOrEqual(previous);
      previous = row.monthsUntilDue;
    }
    // 第一筆必是「已經該檢查卻還沒檢查」的人：可能是逾期，也可能是從未健檢
    // 且到職日推算的基準日早已過去（種子資料中 E007 就比任何 overdue 更急迫）。
    expect(["overdue", "never"]).toContain(due.employees[0]?.status);
    expect(due.employees[0]?.monthsUntilDue).toBeLessThan(0);
    expect(due.employees.filter((item) => item.status === "overdue").length).toBeGreaterThan(0);

    // 狀態與剩餘月數必須自洽。
    for (const row of due.employees) {
      if (row.status === "overdue") expect(row.monthsUntilDue).toBeLessThan(0);
      if (row.status === "ok") expect(row.monthsUntilDue).toBeGreaterThan(due.reminderMonths);
      if (row.status === "due_soon") {
        expect(row.monthsUntilDue).toBeGreaterThanOrEqual(0);
        expect(row.monthsUntilDue).toBeLessThanOrEqual(due.reminderMonths);
      }
      if (row.status === "never") expect(row.lastCheckDate).toBeNull();
    }
  });

  it("從未健檢者以到職日為基準推算延遲，且預設視窗就看得到", async () => {
    const due = await fetchDue();
    const never = due.employees.filter((item) => item.status === "never");
    expect(never.length).toBeGreaterThan(0);
    for (const row of never) {
      expect(row.lastCheckDate).toBeNull();
      expect(row.dueBasis).toBe("hire_date");
      expect(row.nextDueDate).not.toBeNull();
    }
    // E007 到職 2022-04-18、52 歲（3 年一次），基準日 2025-04-18 已過，必為已延遲。
    const e007 = byEmployeeNo(due.employees).get("E007");
    expect(e007?.status).toBe("never");
    expect(e007?.monthsUntilDue).toBeLessThan(0);
  });

  it("?months= 確實改變篩選結果，預設值取自 settings", async () => {
    const preset = await fetchDue();
    const wide = await fetchDue(FULL_WINDOW);
    const narrow = await fetchDue(1);

    expect(preset.windowMonths).toBe(preset.reminderMonths);
    expect(preset.reminderMonths).toBe(2);
    expect(wide.windowMonths).toBe(FULL_WINDOW);

    expect(wide.employees.length).toBeGreaterThan(preset.employees.length);
    expect(preset.employees.length).toBeGreaterThan(0);
    expect(narrow.employees.length).toBeLessThanOrEqual(preset.employees.length);

    // 視窗越大只會多出資料，不會漏掉小視窗已有的人。
    const wideIds = new Set(wide.employees.map((item) => item.employeeId));
    for (const row of preset.employees) expect(wideIds.has(row.employeeId)).toBe(true);

    // 小視窗內不得出現超出視窗的可計算列。
    for (const row of preset.employees) {
      if (row.monthsUntilDue === null) continue;
      expect(row.monthsUntilDue).toBeLessThanOrEqual(preset.windowMonths);
    }
    // ok（尚未到期）只有放大視窗才會進榜，這是預設名單「待健檢」語意的體現。
    expect(preset.employees.some((item) => item.status === "ok")).toBe(false);
    expect(wide.employees.some((item) => item.status === "ok")).toBe(true);

    const invalid = await call("/api/admin/health-checks/due?months=0", {
      headers: { Cookie: adminCookie },
    });
    expect(invalid.response.status).toBe(422);
  });

  it("沒有生日者標為 missing_birth_date，不套用任何預設間隔且永遠留在名單上", async () => {
    const created = await call<{ employee: { id: string } }>(
      "/api/admin/employees",
      adminJson("POST", {
        employeeNo: "E900",
        name: "無生日測試員",
        email: "no.birth@demo.local",
        department: "人資行政部",
        grade: "G3",
        title: "測試專員",
        jobTypeId: "jt-office",
        hireDate: "2015-01-01",
        status: "active",
        salary: 40000,
      }),
    );
    expect(created.response.status).toBe(201);

    for (const months of [undefined, FULL_WINDOW]) {
      const due = await fetchDue(months);
      const row = byEmployeeNo(due.employees).get("E900");
      expect(row?.status).toBe("missing_birth_date");
      expect(row?.statusLabel).toBe("缺生日資料");
      expect(row?.birthDate).toBeNull();
      expect(row?.age).toBeNull();
      expect(row?.intervalMonths).toBeNull(); // 不得靜默套用 60／36／12 任何一個
      expect(row?.nextDueDate).toBeNull();
      expect(row?.monthsUntilDue).toBeNull();
      expect(row?.dueBasis).toBe("unknown");
      // 算不出來的列一律排在最後。
      expect(due.employees[due.employees.length - 1]?.monthsUntilDue).toBeNull();
    }
  });
});

describe("健檢項目主檔 CRUD", () => {
  it("種子資料至少 6 項且含法定必檢項目", async () => {
    const result = await call<{ items: HealthCheckItem[] }>("/api/admin/health-check-items", {
      headers: { Cookie: adminCookie },
    });
    expect(result.response.status).toBe(200);
    const items = result.body.data?.items ?? [];
    expect(items.length).toBeGreaterThanOrEqual(6);
    const names = items.map((item) => item.name);
    expect(names).toContain("胸部 X 光攝影");
    expect(names).toContain("血壓量測");
    expect(names).toContain("血糖檢查");
  });

  it("提供新增、修改、刪除與重複名稱／找不到的錯誤處理", async () => {
    const created = await call<{ id: string }>("/api/admin/health-check-items", adminJson("POST", {
      name: "健檢項目 CRUD 測試",
      category: "測試分類",
      required: false,
      active: true,
      sortOrder: 500,
    }));
    expect(created.response.status).toBe(201);
    const id = created.body.data?.id ?? "";

    const duplicate = await call("/api/admin/health-check-items", adminJson("POST", {
      name: "健檢項目 CRUD 測試",
      category: "重複",
    }));
    expect(duplicate.response.status).toBe(409);

    const invalid = await call("/api/admin/health-check-items", adminJson("POST", { name: "  " }));
    expect(invalid.response.status).toBe(422);

    const updated = await call<{ name: string; required: number }>(
      `/api/admin/health-check-items/${id}`,
      adminJson("PATCH", {
        name: "健檢項目 CRUD 測試（已改）",
        category: "測試分類",
        required: true,
        active: true,
        sortOrder: 501,
      }),
    );
    expect(updated.response.status).toBe(200);
    expect(updated.body.data?.required).toBe(1);

    const missing = await call("/api/admin/health-check-items/not-exist", adminJson("PATCH", {
      name: "不存在",
    }));
    expect(missing.response.status).toBe(404);

    // 未被任何健檢紀錄引用 → 實體刪除。
    const deleted = await call<{ deleted: boolean; archived: boolean }>(
      `/api/admin/health-check-items/${id}`,
      { method: "DELETE", headers: { Cookie: adminCookie } },
    );
    expect(deleted.response.status).toBe(200);
    expect(deleted.body.data?.deleted).toBe(true);

    const deletedAgain = await call(`/api/admin/health-check-items/${id}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(deletedAgain.response.status).toBe(404);
  });

  it("已被健檢紀錄引用的項目改為停用而非刪列，歷史紀錄不斷鏈", async () => {
    const deleted = await call<{ deleted: boolean; archived: boolean }>(
      "/api/admin/health-check-items/hci-xray",
      { method: "DELETE", headers: { Cookie: adminCookie } },
    );
    expect(deleted.response.status).toBe(200);
    expect(deleted.body.data?.deleted).toBe(false);
    expect(deleted.body.data?.archived).toBe(true);

    const items = await call<{ items: HealthCheckItem[] }>("/api/admin/health-check-items", {
      headers: { Cookie: adminCookie },
    });
    expect(items.body.data?.items.find((item) => item.id === "hci-xray")?.active).toBe(0);

    // 舊紀錄仍讀得到該項目（帶 itemActive 讓前端可標示為已停用）。
    const checks = await call<{ healthChecks: HealthCheckRecord[] }>(
      "/api/admin/health-checks?employeeId=emp-001",
      { headers: { Cookie: adminCookie } },
    );
    const xray = checks.body.data?.healthChecks[0]?.items.find((item) => item.itemId === "hci-xray");
    expect(xray?.itemName).toBe("胸部 X 光攝影");
    expect(xray?.itemActive).toBe(0);
  });
});

describe("健檢紀錄 CRUD（含項目）", () => {
  it("建立含多個項目的健檢紀錄後可完整讀回", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const created = await call<HealthCheckRecord>("/api/admin/health-checks", adminJson("POST", {
      employeeId: "emp-008",
      checkDate: today,
      institution: "測試健檢中心",
      notes: "新進員工健檢",
      items: [
        { itemId: "hci-xray", result: "normal", notes: "" },
        { itemId: "hci-bp", result: "abnormal", notes: "收縮壓 148" },
        { itemId: "hci-glucose", result: "pending", notes: "" },
      ],
    }));
    expect(created.response.status).toBe(201);
    expect(created.body.data?.items).toHaveLength(3);
    expect(created.body.data?.employeeNo).toBe("E008");
    const id = created.body.data?.id ?? "";

    const listed = await call<{ healthChecks: HealthCheckRecord[] }>(
      "/api/admin/health-checks?employeeId=emp-008",
      { headers: { Cookie: adminCookie } },
    );
    expect(listed.response.status).toBe(200);
    const record = listed.body.data?.healthChecks.find((item) => item.id === id);
    expect(record?.institution).toBe("測試健檢中心");
    expect(record?.items.map((item) => item.itemId).sort()).toEqual(
      ["hci-bp", "hci-glucose", "hci-xray"],
    );
    const bp = record?.items.find((item) => item.itemId === "hci-bp");
    expect(bp?.result).toBe("abnormal");
    expect(bp?.resultLabel).toBe("異常");
    expect(bp?.notes).toBe("收縮壓 148");

    // 建立後該員工不再是 never，且應檢日改以這次健檢為基準。
    const due = await fetchDue(FULL_WINDOW);
    const row = byEmployeeNo(due.employees).get("E008");
    expect(row?.status).not.toBe("never");
    expect(row?.lastCheckDate).toBe(today);
    expect(row?.dueBasis).toBe("last_check");
  });

  it("PATCH 整筆取代（含項目），DELETE 連同項目一併移除", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const created = await call<HealthCheckRecord>("/api/admin/health-checks", adminJson("POST", {
      employeeId: "emp-010",
      checkDate: today,
      institution: "原機構",
      notes: "",
      items: [
        { itemId: "hci-xray", result: "normal", notes: "" },
        { itemId: "hci-bp", result: "normal", notes: "" },
      ],
    }));
    expect(created.response.status).toBe(201);
    const id = created.body.data?.id ?? "";

    const updated = await call<HealthCheckRecord>(
      `/api/admin/health-checks/${id}`,
      adminJson("PATCH", {
        employeeId: "emp-010",
        checkDate: today,
        institution: "新機構",
        notes: "已更新",
        items: [{ itemId: "hci-liver", result: "follow_up", notes: "GPT 偏高" }],
      }),
    );
    expect(updated.response.status).toBe(200);
    expect(updated.body.data?.institution).toBe("新機構");
    expect(updated.body.data?.items).toHaveLength(1);
    expect(updated.body.data?.items[0]?.itemId).toBe("hci-liver");

    const deleted = await call(`/api/admin/health-checks/${id}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(deleted.response.status).toBe(200);

    const deletedAgain = await call(`/api/admin/health-checks/${id}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(deletedAgain.response.status).toBe(404);
  });

  it("驗證錯誤回 422、找不到回 404、同人同日重複回 409", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const future = new Date();
    future.setUTCDate(future.getUTCDate() + 7);

    const futureDate = await call("/api/admin/health-checks", adminJson("POST", {
      employeeId: "emp-014",
      checkDate: future.toISOString().slice(0, 10),
    }));
    expect(futureDate.response.status).toBe(422);

    const badDate = await call("/api/admin/health-checks", adminJson("POST", {
      employeeId: "emp-014",
      checkDate: "2026/01/01",
    }));
    expect(badDate.response.status).toBe(422);

    const duplicatedItem = await call("/api/admin/health-checks", adminJson("POST", {
      employeeId: "emp-014",
      checkDate: today,
      items: [{ itemId: "hci-bp" }, { itemId: "hci-bp" }],
    }));
    expect(duplicatedItem.response.status).toBe(422);

    const badResult = await call("/api/admin/health-checks", adminJson("POST", {
      employeeId: "emp-014",
      checkDate: today,
      items: [{ itemId: "hci-bp", result: "great" }],
    }));
    expect(badResult.response.status).toBe(422);

    const unknownEmployee = await call("/api/admin/health-checks", adminJson("POST", {
      employeeId: "emp-not-exist",
      checkDate: today,
    }));
    expect(unknownEmployee.response.status).toBe(404);

    const unknownItem = await call("/api/admin/health-checks", adminJson("POST", {
      employeeId: "emp-014",
      checkDate: today,
      items: [{ itemId: "hci-not-exist" }],
    }));
    expect(unknownItem.response.status).toBe(404);

    const first = await call("/api/admin/health-checks", adminJson("POST", {
      employeeId: "emp-014",
      checkDate: today,
    }));
    expect(first.response.status).toBe(201);
    const second = await call("/api/admin/health-checks", adminJson("POST", {
      employeeId: "emp-014",
      checkDate: today,
      institution: "另一家",
    }));
    expect(second.response.status).toBe(409);
  });
});

describe("特種個資的存取控制", () => {
  it("員工只取得自己的健檢紀錄與下次應檢日", async () => {
    const mine = await call<EmployeeHealthResponse>("/api/employee/health-checks", {
      headers: { Cookie: employeeCookie },
    });
    expect(mine.response.status).toBe(200);
    const records = mine.body.data?.healthChecks ?? [];
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) expect(record.employeeId).toBe("emp-002");
    expect(mine.body.data?.summary?.employeeId).toBe("emp-002");
    expect(mine.body.data?.summary?.status).toBe("due_soon");
    expect(mine.body.data?.summary?.intervalMonths).toBe(36);
    expect(mine.body.data?.summary?.nextDueDate).not.toBeNull();

    const other = await call<EmployeeHealthResponse>("/api/employee/health-checks", {
      headers: { Cookie: employeeCookie2 },
    });
    expect(other.response.status).toBe(200);
    const otherRecords = other.body.data?.healthChecks ?? [];
    for (const record of otherRecords) expect(record.employeeId).toBe("emp-005");
    expect(other.body.data?.summary?.employeeId).toBe("emp-005");

    const mineIds = new Set(records.map((record) => record.id));
    for (const record of otherRecords) expect(mineIds.has(record.id)).toBe(false);
  });

  it("員工帶 ?employeeId= 也無法取得他人紀錄（過濾綁在 SQL 而非查詢參數）", async () => {
    const spoofed = await call<EmployeeHealthResponse>(
      "/api/employee/health-checks?employeeId=emp-005",
      { headers: { Cookie: employeeCookie } },
    );
    expect(spoofed.response.status).toBe(200);
    expect(spoofed.body.data?.summary?.employeeId).toBe("emp-002");
    for (const record of spoofed.body.data?.healthChecks ?? []) {
      expect(record.employeeId).toBe("emp-002");
    }
  });

  it("員工打 admin 健檢端點一律 403", async () => {
    for (const path of ADMIN_ENDPOINTS) {
      const result = await call(path, { headers: { Cookie: employeeCookie } });
      expect(`${path}:${result.response.status}`).toBe(`${path}:403`);
    }
    const post = await call("/api/admin/health-checks", jsonRequest("POST", employeeCookie, {
      employeeId: "emp-005",
      checkDate: "2026-01-01",
    }));
    expect(post.response.status).toBe(403);
    const patchItem = await call(
      "/api/admin/health-check-items/hci-bp",
      jsonRequest("PATCH", employeeCookie, { name: "改名嘗試" }),
    );
    expect(patchItem.response.status).toBe(403);
  });

  it("未登入者無法讀取任何健檢端點", async () => {
    for (const path of [...ADMIN_ENDPOINTS, "/api/employee/health-checks"]) {
      const result = await call(path);
      expect(`${path}:${result.response.status}`).toBe(`${path}:401`);
    }
  });

  it("健檢資料不會出現在員工端首頁等非本人端點", async () => {
    const home = await call<Record<string, unknown>>("/api/employee/home", {
      headers: { Cookie: employeeCookie },
    });
    expect(home.response.status).toBe(200);
    const serialized = JSON.stringify(home.body.data ?? {});
    expect(serialized).not.toContain("healthCheck");
    expect(serialized).not.toContain("國泰健康管理中心");
  });
});

describe("儀表板提醒與設定", () => {
  it("admin 儀表板帶出健檢提醒（on-read 計算，不另設排程）", async () => {
    const dashboard = await call<{ healthCheckReminders: DueEmployee[] }>(
      "/api/admin/dashboard",
      { headers: { Cookie: adminCookie } },
    );
    expect(dashboard.response.status).toBe(200);
    const reminders = dashboard.body.data?.healthCheckReminders ?? [];
    expect(reminders.length).toBeGreaterThan(0);
    expect(reminders.some((item) => item.status === "overdue")).toBe(true);
    // 與 /due 預設視窗同一份結果。
    const due = await fetchDue();
    expect(reminders.map((item) => item.employeeId)).toEqual(
      due.employees.map((item) => item.employeeId),
    );
  });

  it("health_check_reminder_months 限制 1～3，且會改變 due_soon 判定", async () => {
    const tooLarge = await call("/api/admin/settings", adminJson("PATCH", {
      updates: [{ key: "health_check_reminder_months", value: 4 }],
    }));
    expect(tooLarge.response.status).toBe(422);

    const tooSmall = await call("/api/admin/settings", adminJson("PATCH", {
      updates: [{ key: "health_check_reminder_months", value: 0 }],
    }));
    expect(tooSmall.response.status).toBe(422);

    const ok = await call("/api/admin/settings", adminJson("PATCH", {
      updates: [{ key: "health_check_reminder_months", value: 3 }],
    }));
    expect(ok.response.status).toBe(200);

    const due = await fetchDue();
    expect(due.reminderMonths).toBe(3);
    expect(due.windowMonths).toBe(3);
    for (const row of due.employees) {
      if (row.status !== "due_soon") continue;
      expect(row.monthsUntilDue).toBeLessThanOrEqual(3);
    }
  });
});
