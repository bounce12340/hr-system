import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { message: string; details?: unknown };
}

interface CompetencyRow {
  id: string;
  positionTitle: string;
  competencyName: string;
  requiredLevel: number;
  description: string;
}

interface NineGridRow {
  employeeId: string;
  name: string;
  performance: number | null;
  potential: number | null;
  performanceLabel: string | null;
  potentialLabel: string | null;
  reviewPeriod: string | null;
}

interface KeyPositionRow {
  id: string;
  title: string;
  department: string;
  incumbentEmployeeId: string | null;
  riskLevel: string;
  riskLevelLabel: string;
  successorCount: number;
}

interface SuccessorRow {
  id: string;
  employeeId: string;
  readiness: string;
  readinessLabel: string;
}

interface IdpItem {
  id: string;
  action: string;
  dueDate: string;
  status: string;
  statusLabel: string;
  employeeNotes: string;
}

interface IdpPlan {
  id: string;
  employeeId: string;
  title: string;
  status: string;
  items: IdpItem[];
}

let adminCookie = "";
let employeeCookie = ""; // emp-002／chiahao.lin，README 記載的 demo 員工帳號
let employeeCookie2 = ""; // emp-005／peishan.li，用於驗證跨員工隔離

const ADMIN_ENDPOINTS = [
  "/api/admin/talent/competencies",
  "/api/admin/talent/nine-grid",
  "/api/admin/talent/key-positions",
  "/api/admin/talent/idp-plans",
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

beforeAll(async () => {
  adminCookie = await loginAndChange("admin@demo.local", "AdminM5Changed1234!");
  employeeCookie = await loginAndChange("chiahao.lin@demo.local", "EmployeeM5Changed1234!");
  employeeCookie2 = await loginAndChange("peishan.li@demo.local", "EmployeeM5bChanged1234!");
});

describe("M5 職能模型 CRUD", () => {
  it("種子資料涵蓋至少 2 個職位、各含多個職能項目", async () => {
    const result = await call<{ competencies: CompetencyRow[] }>(
      "/api/admin/talent/competencies",
      { headers: { Cookie: adminCookie } },
    );
    expect(result.response.status).toBe(200);
    const byPosition = new Map<string, CompetencyRow[]>();
    for (const item of result.body.data?.competencies ?? []) {
      byPosition.set(item.positionTitle, [...(byPosition.get(item.positionTitle) ?? []), item]);
    }
    const positionsWithMultipleItems = [...byPosition.values()].filter((items) => items.length >= 2);
    expect(positionsWithMultipleItems.length).toBeGreaterThanOrEqual(2);
  });

  it("提供新增、修改、刪除與必要等級驗證", async () => {
    const invalid = await call("/api/admin/talent/competencies", adminJson("POST", {
      positionTitle: "M5 CRUD 測試職位",
      competencyName: "測試職能",
      requiredLevel: 6,
      description: "超出範圍",
    }));
    expect(invalid.response.status).toBe(422);

    const created = await call<{ id: string }>("/api/admin/talent/competencies", adminJson("POST", {
      positionTitle: "M5 CRUD 測試職位",
      competencyName: "測試職能",
      requiredLevel: 3,
      description: "原始說明",
    }));
    expect(created.response.status).toBe(201);
    const id = created.body.data?.id ?? "";

    const duplicate = await call("/api/admin/talent/competencies", adminJson("POST", {
      positionTitle: "M5 CRUD 測試職位",
      competencyName: "測試職能",
      requiredLevel: 4,
      description: "重複項目",
    }));
    expect(duplicate.response.status).toBe(409);

    const updated = await call(`/api/admin/talent/competencies/${id}`, adminJson("PATCH", {
      positionTitle: "M5 CRUD 測試職位",
      competencyName: "測試職能",
      requiredLevel: 5,
      description: "已更新",
    }));
    expect(updated.response.status).toBe(200);

    const deleted = await call(`/api/admin/talent/competencies/${id}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(deleted.response.status).toBe(200);

    const deletedAgain = await call(`/api/admin/talent/competencies/${id}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(deletedAgain.response.status).toBe(404);
  });
});

describe("M5 九宮格", () => {
  it("列出所有在職員工，未定位者 performance／potential 為 null", async () => {
    const result = await call<{ grid: NineGridRow[] }>("/api/admin/talent/nine-grid", {
      headers: { Cookie: adminCookie },
    });
    expect(result.response.status).toBe(200);
    const grid = result.body.data?.grid ?? [];
    // 種子：15 位員工，emp-009／011／013 已離職，故在職 12 人。
    expect(grid).toHaveLength(12);
    const unplaced = grid.find((row) => row.employeeId === "emp-014");
    expect(unplaced?.performance).toBeNull();
    expect(unplaced?.potentialLabel).toBeNull();
    const placed = grid.find((row) => row.employeeId === "emp-002");
    expect(placed?.performance).toBe(3);
    expect(placed?.performanceLabel).toBe("高");
    // 分佈於不同格子，而非全部落在同一格。
    const distinctCells = new Set(
      grid.filter((row) => row.performance !== null).map((row) => `${row.performance}-${row.potential}`),
    );
    expect(distinctCells.size).toBeGreaterThan(1);
  });

  it("同員工設定兩次只留一筆，並反映最新落點", async () => {
    const first = await call("/api/admin/talent/nine-grid/emp-004", adminJson("PUT", {
      performance: 1,
      potential: 1,
      reviewPeriod: "2026-H1",
      notes: "第一次設定",
    }));
    expect(first.response.status).toBe(200);

    const second = await call("/api/admin/talent/nine-grid/emp-004", adminJson("PUT", {
      performance: 2,
      potential: 3,
      reviewPeriod: "2026-H2",
      notes: "第二次設定，覆蓋前一筆",
    }));
    expect(second.response.status).toBe(200);

    const list = await call<{ grid: NineGridRow[] }>("/api/admin/talent/nine-grid", {
      headers: { Cookie: adminCookie },
    });
    const rows = (list.body.data?.grid ?? []).filter((row) => row.employeeId === "emp-004");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.performance).toBe(2);
    expect(rows[0]?.potential).toBe(3);
    expect(rows[0]?.reviewPeriod).toBe("2026-H2");
  });

  it("績效／潛力超出 1～3 範圍時回 422，員工不存在回 404", async () => {
    const invalid = await call("/api/admin/talent/nine-grid/emp-004", adminJson("PUT", {
      performance: 4,
      potential: 1,
      reviewPeriod: "2026-H1",
      notes: "",
    }));
    expect(invalid.response.status).toBe(422);

    const missing = await call("/api/admin/talent/nine-grid/not-an-employee", adminJson("PUT", {
      performance: 1,
      potential: 1,
      reviewPeriod: "2026-H1",
      notes: "",
    }));
    expect(missing.response.status).toBe(404);
  });
});

describe("M5 關鍵職位與繼任者", () => {
  it("種子資料含 2 個關鍵職位，繼任者準備度三種皆出現", async () => {
    const positions = await call<{ keyPositions: KeyPositionRow[] }>(
      "/api/admin/talent/key-positions",
      { headers: { Cookie: adminCookie } },
    );
    expect(positions.response.status).toBe(200);
    const kp01 = positions.body.data?.keyPositions.find((row) => row.id === "kp-01");
    expect(kp01?.successorCount).toBe(3);

    const successors = await call<{ successors: SuccessorRow[] }>(
      "/api/admin/talent/key-positions/kp-01/successors",
      { headers: { Cookie: adminCookie } },
    );
    expect(successors.response.status).toBe(200);
    const readinessSet = new Set(successors.body.data?.successors.map((row) => row.readiness));
    expect(readinessSet).toEqual(new Set(["ready_now", "one_two_years", "three_plus_years"]));
    expect(successors.body.data?.successors.find((row) => row.readiness === "ready_now")?.readinessLabel)
      .toBe("立即可接任");
  });

  it("關鍵職位與繼任者提供完整 CRUD，並驗證準備度值域", async () => {
    const created = await call<{ id: string }>("/api/admin/talent/key-positions", adminJson("POST", {
      title: "M5 CRUD 測試職位",
      department: "人資行政部",
      incumbentEmployeeId: null,
      notes: "測試用",
    }));
    expect(created.response.status).toBe(201);
    expect(created.body.data && (created.body.data as unknown as { riskLevelLabel: string }).riskLevelLabel)
      .toBe("中");
    const keyPositionId = created.body.data?.id ?? "";

    const updated = await call(`/api/admin/talent/key-positions/${keyPositionId}`, adminJson("PATCH", {
      title: "M5 CRUD 測試職位",
      department: "人資行政部",
      incumbentEmployeeId: "emp-001",
      riskLevel: "high",
      notes: "已指定現任人員",
    }));
    expect(updated.response.status).toBe(200);

    const badReadiness = await call(
      `/api/admin/talent/key-positions/${keyPositionId}/successors`,
      adminJson("POST", { employeeId: "emp-004", readiness: "next_week", notes: "" }),
    );
    expect(badReadiness.response.status).toBe(422);

    const successor = await call<{ id: string }>(
      `/api/admin/talent/key-positions/${keyPositionId}/successors`,
      adminJson("POST", { employeeId: "emp-004", readiness: "ready_now", notes: "測試繼任者" }),
    );
    expect(successor.response.status).toBe(201);
    const successorId = successor.body.data?.id ?? "";

    const duplicateSuccessor = await call(
      `/api/admin/talent/key-positions/${keyPositionId}/successors`,
      adminJson("POST", { employeeId: "emp-004", readiness: "one_two_years", notes: "" }),
    );
    expect(duplicateSuccessor.response.status).toBe(409);

    const updatedSuccessor = await call(`/api/admin/talent/successors/${successorId}`, adminJson("PATCH", {
      readiness: "three_plus_years",
      notes: "調整準備度",
    }));
    expect(updatedSuccessor.response.status).toBe(200);

    const deletedSuccessor = await call(`/api/admin/talent/successors/${successorId}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(deletedSuccessor.response.status).toBe(200);

    const deletedPosition = await call(`/api/admin/talent/key-positions/${keyPositionId}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(deletedPosition.response.status).toBe(200);

    const successorsAfterDelete = await call(
      `/api/admin/talent/key-positions/${keyPositionId}/successors`,
      { headers: { Cookie: adminCookie } },
    );
    expect(successorsAfterDelete.response.status).toBe(404);
  });
});

describe("M5 IDP 個人發展計畫（admin）", () => {
  it("可依 employeeId 篩選，並附帶行動項目", async () => {
    const filtered = await call<{ idpPlans: IdpPlan[] }>(
      "/api/admin/talent/idp-plans?employeeId=emp-002",
      { headers: { Cookie: adminCookie } },
    );
    expect(filtered.response.status).toBe(200);
    expect(filtered.body.data?.idpPlans).toHaveLength(1);
    expect(filtered.body.data?.idpPlans[0]?.items.length).toBeGreaterThanOrEqual(2);

    const all = await call<{ idpPlans: IdpPlan[] }>("/api/admin/talent/idp-plans", {
      headers: { Cookie: adminCookie },
    });
    expect((all.body.data?.idpPlans.length ?? 0)).toBeGreaterThanOrEqual(3);
  });

  it("提供計畫與行動項目的完整 CRUD", async () => {
    const badDates = await call("/api/admin/talent/idp-plans", adminJson("POST", {
      employeeId: "emp-004",
      title: "日期顛倒測試",
      goal: "測試",
      startDate: "2026-06-01",
      dueDate: "2026-01-01",
      status: "active",
    }));
    expect(badDates.response.status).toBe(422);

    const missingEmployee = await call("/api/admin/talent/idp-plans", adminJson("POST", {
      employeeId: "not-an-employee",
      title: "找不到員工",
      goal: "測試",
      startDate: "2026-01-01",
      dueDate: "2026-06-01",
      status: "active",
    }));
    expect(missingEmployee.response.status).toBe(404);

    const created = await call<{ id: string }>("/api/admin/talent/idp-plans", adminJson("POST", {
      employeeId: "emp-004",
      title: "M5 CRUD 測試計畫",
      goal: "驗證計畫 CRUD",
      startDate: "2026-01-01",
      dueDate: "2026-12-31",
      status: "active",
    }));
    expect(created.response.status).toBe(201);
    const planId = created.body.data?.id ?? "";

    const updated = await call(`/api/admin/talent/idp-plans/${planId}`, adminJson("PATCH", {
      employeeId: "emp-004",
      title: "M5 CRUD 測試計畫（更新）",
      goal: "驗證計畫 CRUD",
      startDate: "2026-01-01",
      dueDate: "2026-12-31",
      status: "draft",
    }));
    expect(updated.response.status).toBe(200);

    const item = await call<{ id: string }>(`/api/admin/talent/idp-plans/${planId}/items`, adminJson("POST", {
      action: "測試行動項目",
      dueDate: "2026-06-01",
    }));
    expect(item.response.status).toBe(201);
    const itemId = item.body.data?.id ?? "";

    const updatedItem = await call(`/api/admin/talent/idp-items/${itemId}`, adminJson("PATCH", {
      action: "測試行動項目（更新）",
      dueDate: "2026-07-01",
      status: "in_progress",
      employeeNotes: "admin 可任意調整",
    }));
    expect(updatedItem.response.status).toBe(200);

    const deletedItem = await call(`/api/admin/talent/idp-items/${itemId}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(deletedItem.response.status).toBe(200);

    const deletedPlan = await call(`/api/admin/talent/idp-plans/${planId}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(deletedPlan.response.status).toBe(200);
  });
});

describe("M5 權限：人才盤點屬敏感資料，admin-only", () => {
  it("employee 帳號打任一 admin talent 端點皆得 403", async () => {
    for (const endpoint of ADMIN_ENDPOINTS) {
      const result = await call(endpoint, { headers: { Cookie: employeeCookie } });
      expect(result.response.status, endpoint).toBe(403);
    }
    const write = await call("/api/admin/talent/competencies", jsonRequest("POST", employeeCookie, {
      positionTitle: "不應寫入",
      competencyName: "不應寫入",
      requiredLevel: 1,
      description: "",
    }));
    expect(write.response.status).toBe(403);
  });
});

describe("M5 員工端：自己的 IDP", () => {
  it("只回自己的 IDP 計畫與項目", async () => {
    const own = await call<{ idpPlans: IdpPlan[] }>("/api/employee/idp", {
      headers: { Cookie: employeeCookie },
    });
    expect(own.response.status).toBe(200);
    expect(own.body.data?.idpPlans).toHaveLength(1);
    expect(own.body.data?.idpPlans[0]?.employeeId).toBe("emp-002");

    const other = await call<{ idpPlans: IdpPlan[] }>("/api/employee/idp", {
      headers: { Cookie: employeeCookie2 },
    });
    expect(other.response.status).toBe(200);
    expect(other.body.data?.idpPlans).toHaveLength(1);
    expect(other.body.data?.idpPlans[0]?.employeeId).toBe("emp-005");
  });

  it("可更新自己項目的 status 與 employeeNotes，其餘欄位不受影響", async () => {
    const before = await call<{ idpPlans: IdpPlan[] }>("/api/employee/idp", {
      headers: { Cookie: employeeCookie },
    });
    const targetItem = before.body.data?.idpPlans[0]?.items.find((item) => item.id === "idpi-02");
    expect(targetItem).toBeDefined();
    const originalAction = targetItem?.action ?? "";
    const originalDueDate = targetItem?.dueDate ?? "";

    const updated = await call(
      "/api/employee/idp/items/idpi-02",
      jsonRequest("PATCH", employeeCookie, {
        status: "in_progress",
        employeeNotes: "員工自行更新的備註",
        action: "嘗試竄改行動項目內容",
        dueDate: "2099-01-01",
      }),
    );
    expect(updated.response.status).toBe(200);

    const after = await call<{ idpPlans: IdpPlan[] }>("/api/employee/idp", {
      headers: { Cookie: employeeCookie },
    });
    const afterItem = after.body.data?.idpPlans[0]?.items.find((item) => item.id === "idpi-02");
    expect(afterItem?.status).toBe("in_progress");
    expect(afterItem?.employeeNotes).toBe("員工自行更新的備註");
    // action／dueDate 不在允許更新欄位內，即使 body 夾帶也不應變動。
    expect(afterItem?.action).toBe(originalAction);
    expect(afterItem?.dueDate).toBe(originalDueDate);
  });

  it("無法更新他人名下的 IDP 項目", async () => {
    // idpi-04 屬於 emp-005（idp-02），employeeCookie 是 emp-002。
    const blocked = await call(
      "/api/employee/idp/items/idpi-04",
      jsonRequest("PATCH", employeeCookie, { status: "completed", employeeNotes: "不應成功" }),
    );
    expect(blocked.response.status).toBe(404);

    // 反向驗證：emp-005 的 cookie 可以更新自己的 idpi-04。
    const allowed = await call(
      "/api/employee/idp/items/idpi-04",
      jsonRequest("PATCH", employeeCookie2, { status: "completed", employeeNotes: "emp-005 自行更新" }),
    );
    expect(allowed.response.status).toBe(200);
  });

  it("狀態值不正確時回 422", async () => {
    const invalid = await call(
      "/api/employee/idp/items/idpi-03",
      jsonRequest("PATCH", employeeCookie, { status: "not_a_status", employeeNotes: "" }),
    );
    expect(invalid.response.status).toBe(422);
  });
});
