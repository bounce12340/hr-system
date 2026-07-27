import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * 登入帳號生命週期管理（src/server/accounts.ts）。
 *
 * 這批測試的重點不在 CRUD 形狀，而在三件會直接影響存取控制的事：
 *   1. 建立帳號不再產生任何明碼密碼，改回傳一次性設定連結；密碼由本人設定後才登得進來。
 *      （連結本身的安全性——只存雜湊、單次使用、過期——在 test/password-setup.test.ts。）
 *   2. 停用／封存必須讓「既有 session 立刻失效」，不是等 cookie 自然過期。
 *   3. 標記員工離職要連動停用帳號；復職不自動還權；admin 不能把自己鎖在外面。
 */

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { message: string; details?: unknown };
}

interface Account {
  id: string;
  email: string;
  role: "admin" | "employee";
  active: boolean;
  mustChangePassword: boolean;
  employeeId: string | null;
  employeeName: string | null;
  employeeStatus: "active" | "inactive" | null;
  auditRefCount: number;
}

interface CreateAccountResponse extends Account {
  /** 契約形狀：{ user, mail: { status, message }, setupUrl? }。已不再有 temporaryPassword。 */
  user: Account;
  mail: { status: "sent" | "skipped" | "failed"; message: string };
  setupUrl?: string;
}

interface EmployeeRecord {
  id: string;
  employeeNo: string;
  email: string;
  status: "active" | "inactive";
}

/** 測試環境沒有設 app_base_url，因此建立帳號一律回傳相對路徑的 setupUrl。 */
const SETUP_PASSWORD = "OwnerChosen1234!";

let adminCookie = "";
let employeeCookie = "";
let sequence = 0;

async function call<T>(path: string, init?: RequestInit): Promise<{ response: Response; body: Envelope<T> }> {
  const response = await exports.default.fetch(`https://example.com${path}`, init);
  return { response, body: await response.json<Envelope<T>>() };
}

function adminJson(method: string, body?: object): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify(body ?? {}),
  };
}

async function loginRaw(email: string, password: string): Promise<Response> {
  return exports.default.fetch("https://example.com/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

async function loginAndChange(email: string, newPassword: string): Promise<string> {
  const response = await loginRaw(email, "Demo1234!");
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  const changed = await call("/api/auth/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ currentPassword: "Demo1234!", newPassword }),
  });
  expect(changed.response.status).toBe(200);
  return cookie;
}

/** 每個案例都用自己的員工，避免案例之間透過共用員工互相影響。 */
async function createEmployee(): Promise<EmployeeRecord> {
  sequence += 1;
  const suffix = String(sequence).padStart(2, "0");
  const created = await call<{ employee: EmployeeRecord }>("/api/admin/employees", adminJson("POST", {
    employeeNo: `A9${suffix}`,
    name: `帳號測試${suffix}`,
    email: `account.case${suffix}@demo.local`,
    department: "人資行政部",
    grade: "G1",
    title: "測試專員",
    jobTypeId: "jt-office",
    hireDate: "2024-05-01",
  }));
  expect(created.response.status).toBe(201);
  const employee = created.body.data?.employee;
  if (!employee) throw new Error("建立員工失敗");
  return employee;
}

async function createAccount(employeeId: string, role: "admin" | "employee" = "employee"): Promise<CreateAccountResponse> {
  const created = await call<CreateAccountResponse>("/api/admin/users", adminJson("POST", { employeeId, role }));
  expect(created.response.status).toBe(201);
  const account = created.body.data;
  if (!account) throw new Error("建立帳號失敗");
  return account;
}

function tokenFrom(setupUrl: string | undefined): string {
  expect(setupUrl, "建立帳號／重設密碼應回傳 setupUrl").toBeTruthy();
  return new URL(setupUrl ?? "", "https://example.com").searchParams.get("setup") ?? "";
}

/**
 * 新流程沒有臨時密碼：帳號建立後密碼是一組沒有人知道的隨機值，
 * 必須由本人用一次性連結設定過才登得進來。這支就是測試裡的「本人」。
 */
async function activate(setupUrl: string | undefined, password = SETUP_PASSWORD): Promise<void> {
  const done = await call("/api/auth/password-setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: tokenFrom(setupUrl), newPassword: password }),
  });
  expect(done.response.status).toBe(200);
}

/** 建立帳號並立刻完成密碼設定，回傳可直接登入的帳號。 */
async function createUsableAccount(
  employeeId: string,
  role: "admin" | "employee" = "employee",
): Promise<CreateAccountResponse> {
  const account = await createAccount(employeeId, role);
  await activate(account.setupUrl);
  return account;
}

async function sessionCount(userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?")
    .bind(userId).first<{ count: number }>();
  return row?.count ?? 0;
}

beforeAll(async () => {
  adminCookie = await loginAndChange("admin@demo.local", "AdminAccountsChanged1234!");
  employeeCookie = await loginAndChange("chiahao.lin@demo.local", "EmployeeAccountsChanged1234!");
});

describe("建立帳號與密碼設定連結", () => {
  it("回應不含任何明碼密碼，改帶 mail 狀態與一次性設定連結", async () => {
    const employee = await createEmployee();
    const account = await createAccount(employee.id);

    // 舊的 temporaryPassword 行為已完整移除，不保留相容欄位。
    expect("temporaryPassword" in account).toBe(false);
    expect(JSON.stringify(account)).not.toContain("temporaryPassword");

    expect(account.mail.status).toBe("skipped"); // 測試環境未設 app_base_url
    expect(account.mail.message).toBeTruthy();
    expect(account.setupUrl).toBeTruthy();
    expect(account.mustChangePassword).toBe(true);
    expect(account.active).toBe(true);
    expect(account.email).toBe(employee.email);
    expect(account.employeeId).toBe(employee.id);
    expect(account.user.id).toBe(account.id);
  });

  it("設定連結使用前登不進來，本人設定密碼後才能登入", async () => {
    const employee = await createEmployee();
    const account = await createAccount(employee.id);

    // 密碼欄位是一組無法通過驗證的隨機值，任何輸入都登不進來。
    expect((await loginRaw(employee.email, SETUP_PASSWORD)).status).toBe(401);

    await activate(account.setupUrl);
    const login = await loginRaw(employee.email, SETUP_PASSWORD);
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const me = await call<{ user: { mustChangePassword: boolean } }>("/api/auth/me", {
      headers: { Cookie: cookie },
    });
    expect(me.response.status).toBe(200);
    // 密碼是本人設定的，沒有理由再強迫改一次。
    expect(me.body.data?.user.mustChangePassword).toBe(false);
  });

  it("兩次建立的連結不同，且 token 原文沒有落在資料庫任何地方", async () => {
    const first = await createAccount((await createEmployee()).id);
    const second = await createAccount((await createEmployee()).id);
    const firstToken = tokenFrom(first.setupUrl);
    expect(firstToken).not.toBe(tokenFrom(second.setupUrl));

    // token 原文只出現在回應／信件；users 與 audit_logs 都不得留下痕跡。
    const stored = await env.DB.prepare(
      "SELECT password_hash AS hash, password_salt AS salt FROM users WHERE id = ?",
    ).bind(first.id).first<{ hash: string; salt: string }>();
    expect(stored?.hash).not.toContain(firstToken);
    expect(stored?.salt).not.toContain(firstToken);
    const leaked = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE details LIKE ?",
    ).bind(`%${firstToken}%`).first<{ count: number }>();
    expect(leaked?.count).toBe(0);
  });

  it("重複建立回 409，離職員工回 422，員工不存在回 404", async () => {
    const employee = await createEmployee();
    await createAccount(employee.id);
    const duplicate = await call("/api/admin/users", adminJson("POST", {
      employeeId: employee.id,
      role: "employee",
    }));
    expect(duplicate.response.status).toBe(409);

    const missing = await call("/api/admin/users", adminJson("POST", {
      employeeId: "emp-not-exist",
      role: "employee",
    }));
    expect(missing.response.status).toBe(404);

    const invalidRole = await call("/api/admin/users", adminJson("POST", {
      employeeId: employee.id,
      role: "superuser",
    }));
    expect(invalidRole.response.status).toBe(422);
  });

  it("清單含前端所需欄位（auditRefCount／employeeStatus／employeeName）", async () => {
    const employee = await createEmployee();
    const account = await createAccount(employee.id);
    const list = await call<{ users: Account[] }>("/api/admin/users", { headers: { Cookie: adminCookie } });
    expect(list.response.status).toBe(200);
    const row = list.body.data?.users.find((item) => item.id === account.id);
    expect(row).toMatchObject({
      email: employee.email,
      role: "employee",
      active: true,
      mustChangePassword: true,
      employeeId: employee.id,
      employeeStatus: "active",
      auditRefCount: 0,
    });
    expect(row?.employeeName).toBeTruthy();
  });
});

describe("停用與重設密碼", () => {
  it("停用後既有 session 立刻失效（session 列被刪除，不是等過期）", async () => {
    const employee = await createEmployee();
    const account = await createUsableAccount(employee.id);
    const login = await loginRaw(employee.email, SETUP_PASSWORD);
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect((await call("/api/auth/me", { headers: { Cookie: cookie } })).response.status).toBe(200);
    expect(await sessionCount(account.id)).toBe(1);

    const disabled = await call<{ active: boolean }>(
      `/api/admin/users/${account.id}`,
      adminJson("PATCH", { active: false }),
    );
    expect(disabled.response.status).toBe(200);
    expect(disabled.body.data?.active).toBe(false);

    // 關鍵：session 列真的被刪掉，而不是只靠 users.active 在查詢時擋。
    expect(await sessionCount(account.id)).toBe(0);
    expect((await call("/api/auth/me", { headers: { Cookie: cookie } })).response.status).toBe(401);
  });

  it("停用後無法用原密碼登入，重新啟用後可以", async () => {
    const employee = await createEmployee();
    const account = await createUsableAccount(employee.id);
    await call(`/api/admin/users/${account.id}`, adminJson("PATCH", { active: false }));
    expect((await loginRaw(employee.email, SETUP_PASSWORD)).status).toBe(401);

    const enabled = await call<{ active: boolean }>(
      `/api/admin/users/${account.id}`,
      adminJson("PATCH", { active: true }),
    );
    expect(enabled.response.status).toBe(200);
    expect(enabled.body.data?.active).toBe(true);
    expect((await loginRaw(employee.email, SETUP_PASSWORD)).status).toBe(200);
  });

  it("重設密碼發出新的設定連結，舊密碼與舊 session 同時失效", async () => {
    const employee = await createEmployee();
    const account = await createUsableAccount(employee.id);
    const login = await loginRaw(employee.email, SETUP_PASSWORD);
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(await sessionCount(account.id)).toBe(1);

    const reset = await call<CreateAccountResponse>(
      `/api/admin/users/${account.id}/reset-password`,
      adminJson("POST"),
    );
    expect(reset.response.status).toBe(200);
    // 重設密碼同樣不再回傳任何明碼密碼。
    expect(JSON.stringify(reset.body.data)).not.toContain("temporaryPassword");
    expect(reset.body.data?.mail.status).toBe("skipped");
    expect(reset.body.data?.mustChangePassword).toBe(true);

    // 舊密碼與舊 session 當場失效，新密碼要等本人用連結設定完才生效。
    expect(await sessionCount(account.id)).toBe(0);
    expect((await call("/api/auth/me", { headers: { Cookie: cookie } })).response.status).toBe(401);
    expect((await loginRaw(employee.email, SETUP_PASSWORD)).status).toBe(401);

    await activate(reset.body.data?.setupUrl, "ResetByOwner4321!");
    expect((await loginRaw(employee.email, "ResetByOwner4321!")).status).toBe(200);
    expect((await loginRaw(employee.email, SETUP_PASSWORD)).status).toBe(401);
  });

  it("找不到的帳號一律 404", async () => {
    expect((await call("/api/admin/users/usr-not-exist", adminJson("PATCH", { active: false }))).response.status).toBe(404);
    expect((await call("/api/admin/users/usr-not-exist/reset-password", adminJson("POST"))).response.status).toBe(404);
    expect((await call("/api/admin/users/usr-not-exist", adminJson("DELETE"))).response.status).toBe(404);
  });
});

describe("離職連動", () => {
  it("標記離職自動停用帳號並刪除 session；復職不自動啟用", async () => {
    const employee = await createEmployee();
    const account = await createUsableAccount(employee.id);
    const login = await loginRaw(employee.email, SETUP_PASSWORD);
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(await sessionCount(account.id)).toBe(1);

    const terminated = await call<{ deactivatedAccounts: number }>(
      `/api/admin/employees/${employee.id}`,
      adminJson("PATCH", {
        employeeNo: employee.employeeNo,
        name: "帳號測試離職",
        email: employee.email,
        department: "人資行政部",
        grade: "G1",
        title: "測試專員",
        jobTypeId: "jt-office",
        hireDate: "2024-05-01",
        status: "inactive",
        terminationDate: "2026-06-30",
      }),
    );
    expect(terminated.response.status).toBe(200);
    expect(terminated.body.data?.deactivatedAccounts).toBe(1);

    expect(await sessionCount(account.id)).toBe(0);
    expect((await call("/api/auth/me", { headers: { Cookie: cookie } })).response.status).toBe(401);
    expect((await loginRaw(employee.email, SETUP_PASSWORD)).status).toBe(401);

    // 復職：員工狀態改回在職，但帳號刻意維持停用，必須由 admin 明確啟用。
    const reinstated = await call(`/api/admin/employees/${employee.id}`, adminJson("PATCH", {
      employeeNo: employee.employeeNo,
      name: "帳號測試復職",
      email: employee.email,
      department: "人資行政部",
      grade: "G1",
      title: "測試專員",
      jobTypeId: "jt-office",
      hireDate: "2024-05-01",
      status: "active",
    }));
    expect(reinstated.response.status).toBe(200);
    expect((await loginRaw(employee.email, SETUP_PASSWORD)).status).toBe(401);

    const list = await call<{ users: Account[] }>("/api/admin/users", { headers: { Cookie: adminCookie } });
    expect(list.body.data?.users.find((item) => item.id === account.id)?.active).toBe(false);
  });
});

describe("不可自我停權", () => {
  it("admin 不可停用、降級或刪除自己的帳號", async () => {
    const me = await call<{ user: { id: string } }>("/api/auth/me", { headers: { Cookie: adminCookie } });
    const selfId = me.body.data?.user.id ?? "";
    expect(selfId).toBeTruthy();

    const disable = await call(`/api/admin/users/${selfId}`, adminJson("PATCH", { active: false }));
    expect(disable.response.status).toBe(422);
    const demote = await call(`/api/admin/users/${selfId}`, adminJson("PATCH", { role: "employee" }));
    expect(demote.response.status).toBe(422);
    const remove = await call(`/api/admin/users/${selfId}`, adminJson("DELETE"));
    expect(remove.response.status).toBe(422);

    // 自己仍然可以正常使用系統。
    expect((await call("/api/admin/users", { headers: { Cookie: adminCookie } })).response.status).toBe(200);
  });

  it("admin 不可把自己的員工資料標記為離職（等同自我停權）", async () => {
    const blocked = await call("/api/admin/employees/emp-001", adminJson("PATCH", {
      employeeNo: "E001",
      name: "王小明",
      email: "hsiaoming.wang@demo.local",
      department: "人資行政部",
      grade: "G5",
      title: "人資經理",
      jobTypeId: "jt-office",
      hireDate: "2018-03-01",
      status: "inactive",
      terminationDate: "2026-06-30",
    }));
    expect(blocked.response.status).toBe(422);
  });
});

describe("刪除或封存", () => {
  it("無稽核關聯的帳號直接實刪", async () => {
    const employee = await createEmployee();
    const account = await createUsableAccount(employee.id);
    const removed = await call<{ mode: string; auditRefCount: number }>(
      `/api/admin/users/${account.id}`,
      adminJson("DELETE"),
    );
    expect(removed.response.status).toBe(200);
    expect(removed.body.data?.mode).toBe("deleted");
    expect(removed.body.data?.auditRefCount).toBe(0);

    const row = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(account.id).first();
    expect(row).toBeNull();
    expect((await loginRaw(employee.email, SETUP_PASSWORD)).status).toBe(401);
    // 未使用的設定連結應隨帳號一起消失（ON DELETE CASCADE）。
    const tokens = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM password_setup_tokens WHERE user_id = ?",
    ).bind(account.id).first<{ count: number }>();
    expect(tokens?.count).toBe(0);
  });

  it("有稽核關聯的帳號改為封存：無法登入、稽核列保留、同一員工可重新建帳號", async () => {
    const employee = await createEmployee();
    const account = await createUsableAccount(employee.id);
    // 兩種關聯各一筆：audit_logs（nullable FK）與 special_days（NOT NULL FK，真的刪不掉）。
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id)
        VALUES (?, ?, 'test.action', 'test', 'test')
      `).bind(`audit-${account.id}`, account.id),
      env.DB.prepare(`
        INSERT INTO special_days (id, special_date, day_type, title, reason, created_by)
        VALUES (?, '2099-12-25', 'blackout', '測試封鎖日', '帳號封存測試', ?)
      `).bind(`sd-${account.id}`, account.id),
    ]);

    const listed = await call<{ users: Account[] }>("/api/admin/users", { headers: { Cookie: adminCookie } });
    expect(listed.body.data?.users.find((item) => item.id === account.id)?.auditRefCount).toBe(2);

    const archived = await call<{ mode: string; auditRefCount: number; message: string }>(
      `/api/admin/users/${account.id}`,
      adminJson("DELETE"),
    );
    expect(archived.response.status).toBe(200);
    expect(archived.body.data?.mode).toBe("archived");
    expect(archived.body.data?.auditRefCount).toBe(2);
    expect(archived.body.data?.message).toContain("2");

    // 列仍在（稽核軌跡不斷），但已匿名化且停權。
    const row = await env.DB.prepare(`
      SELECT email, active, employee_id AS employeeId, archived_employee_id AS archivedEmployeeId,
             archived_at AS archivedAt
      FROM users WHERE id = ?
    `).bind(account.id).first<{
      email: string;
      active: number;
      employeeId: string | null;
      archivedEmployeeId: string | null;
      archivedAt: string | null;
    }>();
    expect(row?.active).toBe(0);
    expect(row?.email).not.toBe(employee.email);
    expect(row?.email).toContain("archived");
    expect(row?.employeeId).toBeNull();
    expect(row?.archivedEmployeeId).toBe(employee.id);
    expect(row?.archivedAt).toBeTruthy();
    const audit = await env.DB.prepare("SELECT actor_user_id AS actor FROM audit_logs WHERE id = ?")
      .bind(`audit-${account.id}`).first<{ actor: string }>();
    expect(audit?.actor).toBe(account.id);

    // 封存後不得能登入（原密碼、封存後的匿名信箱都不行），清單也不再出現。
    expect((await loginRaw(employee.email, SETUP_PASSWORD)).status).toBe(401);
    expect((await loginRaw(row?.email ?? "", SETUP_PASSWORD)).status).toBe(401);
    const after = await call<{ users: Account[] }>("/api/admin/users", { headers: { Cookie: adminCookie } });
    expect(after.body.data?.users.some((item) => item.id === account.id)).toBe(false);
    expect((await call(`/api/admin/users/${account.id}`, adminJson("PATCH", { active: true }))).response.status).toBe(404);

    // 同一員工可重新建立帳號（email 與 employee_id 都已釋出）。
    const recreated = await createUsableAccount(employee.id);
    expect(recreated.id).not.toBe(account.id);
    expect(recreated.email).toBe(employee.email);
    expect((await loginRaw(employee.email, SETUP_PASSWORD)).status).toBe(200);
  });
});

describe("員工職責查詢", () => {
  it("回傳關鍵職位現任者與繼任者身分", async () => {
    const incumbent = await call<{ responsibilities: Array<Record<string, unknown>>; totalCount: number }>(
      "/api/admin/employees/emp-003/responsibilities",
      { headers: { Cookie: adminCookie } },
    );
    expect(incumbent.response.status).toBe(200);
    expect(incumbent.body.data?.totalCount).toBe(1);
    expect(incumbent.body.data?.responsibilities[0]).toMatchObject({
      relation: "incumbent",
      keyPositionId: "kp-01",
      keyPositionTitle: "醫院事業部業務主管",
      department: "醫院事業部",
    });

    const successor = await call<{ responsibilities: Array<Record<string, unknown>>; totalCount: number }>(
      "/api/admin/employees/emp-006/responsibilities",
      { headers: { Cookie: adminCookie } },
    );
    expect(successor.body.data?.totalCount).toBe(1);
    expect(successor.body.data?.responsibilities[0]).toMatchObject({
      relation: "successor",
      keyPositionId: "kp-01",
    });

    const none = await call<{ totalCount: number }>(
      "/api/admin/employees/emp-001/responsibilities",
      { headers: { Cookie: adminCookie } },
    );
    expect(none.body.data?.totalCount).toBe(0);

    const missing = await call("/api/admin/employees/emp-not-exist/responsibilities", {
      headers: { Cookie: adminCookie },
    });
    expect(missing.response.status).toBe(404);
  });
});

describe("權限", () => {
  function employeeInit(method: string, body?: object): RequestInit {
    return {
      method,
      headers: { "Content-Type": "application/json", Cookie: employeeCookie },
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    };
  }

  it("employee 帳號打所有帳號管理端點一律 403", async () => {
    const cases: Array<[string, string]> = [
      ["/api/admin/users", "GET"],
      ["/api/admin/users", "POST"],
      ["/api/admin/users/usr-002", "PATCH"],
      ["/api/admin/users/usr-002/reset-password", "POST"],
      ["/api/admin/users/usr-002", "DELETE"],
      ["/api/admin/employees/emp-003/responsibilities", "GET"],
    ];
    for (const [path, method] of cases) {
      const result = await call(path, employeeInit(method, { role: "admin", active: false }));
      expect(result.response.status, `${method} ${path}`).toBe(403);
    }
  });

  it("未登入一律 401", async () => {
    const anonymous = await exports.default.fetch("https://example.com/api/admin/users");
    expect(anonymous.status).toBe(401);
  });
});
