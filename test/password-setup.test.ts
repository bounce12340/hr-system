import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { issuePasswordSetup, passwordSetupHours } from "../src/server/password-setup";

/**
 * 一次性密碼設定連結（src/server/password-setup.ts）。
 *
 * 這批測試幾乎全部是安全性斷言，而不是形狀驗證。取代明碼臨時密碼的整個理由就是
 * 「密碼不該以可轉述的形式存在」，所以每一條防線都必須有測試釘住：
 *   1. 資料庫裡找不到 token 原文（外洩也拿不到可用連結）。
 *   2. 用過一次就不能再用、過期就不能用。
 *   3. 設定成功要把既有 session 踢掉（帳號可能正被他人登入）。
 *   4. forgot-password 對存在與不存在的 email 回應「逐字相同」（帳號列舉）。
 *   5. 連結網域只能來自 app_base_url，不得受 Host header 影響。
 */

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { message: string; details?: unknown };
}

interface Account {
  id: string;
  email: string;
  mustChangePassword: boolean;
  mail: { status: string; message: string };
  setupUrl?: string;
  user: { id: string; email: string };
}

interface TokenInfo {
  valid: boolean;
  emailMasked: string;
  purpose: string;
  expiresAt: string;
}

const SETUP_PASSWORD = "OwnerChosen1234!";

let adminCookie = "";
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

function publicJson(body: object): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** setupUrl 未設定 app_base_url 時是相對路徑，因此一律給 base 再解析。 */
function tokenFrom(setupUrl: string | undefined): string {
  expect(setupUrl, "回應應帶回 setupUrl").toBeTruthy();
  const token = new URL(setupUrl ?? "", "https://example.com").searchParams.get("setup");
  expect(token, "setupUrl 應帶 setup 參數").toBeTruthy();
  return token ?? "";
}

async function setAppBaseUrl(value: string): Promise<void> {
  await env.DB.prepare("UPDATE settings SET setting_value = ? WHERE setting_key = ?")
    .bind(value, "app_base_url").run();
}

async function setTokenHours(value: string): Promise<void> {
  await env.DB.prepare("UPDATE settings SET setting_value = ? WHERE setting_key = ?")
    .bind(value, "password_setup_token_hours").run();
}

async function createEmployee(): Promise<{ id: string; email: string }> {
  sequence += 1;
  const suffix = String(sequence).padStart(2, "0");
  const created = await call<{ employee: { id: string; email: string } }>(
    "/api/admin/employees",
    adminJson("POST", {
      employeeNo: `P9${suffix}`,
      name: `設定連結測試${suffix}`,
      email: `setup.case${suffix}@demo.local`,
      department: "人資行政部",
      grade: "G1",
      title: "測試專員",
      jobTypeId: "jt-office",
      hireDate: "2024-05-01",
    }),
  );
  expect(created.response.status).toBe(201);
  const employee = created.body.data?.employee;
  if (!employee) throw new Error("建立員工失敗");
  return employee;
}

async function createAccount(): Promise<{ account: Account; employeeEmail: string; token: string }> {
  const employee = await createEmployee();
  const created = await call<Account>("/api/admin/users", adminJson("POST", {
    employeeId: employee.id,
    role: "employee",
  }));
  expect(created.response.status).toBe(201);
  const account = created.body.data;
  if (!account) throw new Error("建立帳號失敗");
  return { account, employeeEmail: employee.email, token: tokenFrom(account.setupUrl) };
}

async function completeSetup(token: string, newPassword = SETUP_PASSWORD): Promise<Response> {
  return exports.default.fetch("https://example.com/api/auth/password-setup", publicJson({ token, newPassword }));
}

async function loginRaw(email: string, password: string): Promise<Response> {
  return exports.default.fetch("https://example.com/api/auth/login", publicJson({ email, password }));
}

async function sessionCount(userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?")
    .bind(userId).first<{ count: number }>();
  return row?.count ?? 0;
}

beforeAll(async () => {
  const response = await loginRaw("admin@demo.local", "Demo1234!");
  expect(response.status).toBe(200);
  adminCookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  const changed = await call("/api/auth/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ currentPassword: "Demo1234!", newPassword: "AdminSetupChanged1234!" }),
  });
  expect(changed.response.status).toBe(200);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  // 每個案例自己決定要不要設 app_base_url；預設回到「未設定」。
  await setAppBaseUrl("");
  await setTokenHours("24");
});

describe("token 產生與儲存", () => {
  it("資料庫只存 SHA-256 雜湊，任何欄位都找不到 token 原文", async () => {
    const { token } = await createAccount();
    expect(token.length).toBeGreaterThanOrEqual(43); // 32 bytes → base64url 43 字元
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // base64url，放進網址不需再編碼

    // 逐欄比對：整張表沒有任何欄位等於或包含 token 原文。
    const leaked = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM password_setup_tokens
      WHERE id LIKE ?1 OR user_id LIKE ?1 OR token_hash LIKE ?1
         OR purpose LIKE ?1 OR expires_at LIKE ?1
         OR COALESCE(used_at, '') LIKE ?1 OR created_at LIKE ?1
    `).bind(`%${token}%`).first<{ count: number }>();
    expect(leaked?.count).toBe(0);

    // 存的確實是這個 token 的雜湊（驗證時比對得起來，但反推不回原文）。
    const stored = await env.DB.prepare(
      "SELECT token_hash AS hash FROM password_setup_tokens WHERE token_hash = ?",
    ).bind(await sha256Hex(token)).first<{ hash: string }>();
    expect(stored?.hash).toBe(await sha256Hex(token));

    // 其他地方也不得留下原文。
    const audit = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE details LIKE ?",
    ).bind(`%${token}%`).first<{ count: number }>();
    expect(audit?.count).toBe(0);
  });

  it("每次發放的 token 都不同，且舊的未使用連結會被新的取代", async () => {
    const { account, token: first } = await createAccount();
    const reset = await call<Account>(`/api/admin/users/${account.id}/reset-password`, adminJson("POST"));
    expect(reset.response.status).toBe(200);
    const second = tokenFrom(reset.body.data?.setupUrl);
    expect(second).not.toBe(first);

    // 舊連結已被刪除（不是標記已使用），因此是「不存在」的 404。
    expect((await exports.default.fetch(`https://example.com/api/auth/password-setup/${first}`)).status).toBe(404);
    expect((await exports.default.fetch(`https://example.com/api/auth/password-setup/${second}`)).status).toBe(200);
  });
});

describe("驗證 token（GET /api/auth/password-setup/{token}）", () => {
  it("公開端點：未登入即可存取，回傳遮罩後的 email 與用途", async () => {
    const { token, employeeEmail } = await createAccount();
    // 完全不帶 Cookie。
    const response = await exports.default.fetch(`https://example.com/api/auth/password-setup/${token}`);
    expect(response.status).toBe(200);
    const body = await response.json<Envelope<TokenInfo>>();
    expect(body.data?.valid).toBe(true);
    expect(body.data?.purpose).toBe("account_setup");
    expect(body.data?.expiresAt).toBeTruthy();

    // 遮罩：看得出是不是自己的信箱，但不是完整帳號。
    expect(body.data?.emailMasked).toContain("***");
    expect(body.data?.emailMasked).not.toBe(employeeEmail);
    expect(body.data?.emailMasked).toContain("@demo.local");
  });

  it("不存在的 token 回 404，過期與已使用回 410，且訊息不洩漏所屬帳號", async () => {
    const { token, employeeEmail, account } = await createAccount();

    const missing = await exports.default.fetch("https://example.com/api/auth/password-setup/not-a-real-token");
    expect(missing.status).toBe(404);

    // 過期：直接把 expires_at 改到過去。
    await env.DB.prepare("UPDATE password_setup_tokens SET expires_at = ? WHERE token_hash = ?")
      .bind("2020-01-01T00:00:00.000Z", await sha256Hex(token)).run();
    const expired = await exports.default.fetch(`https://example.com/api/auth/password-setup/${token}`);
    expect(expired.status).toBe(410);
    const expiredBody = await expired.json<Envelope<never>>();
    expect(expiredBody.error?.message).toContain("過期");
    // 關鍵：失效訊息不得洩漏這條連結屬於誰。
    const serialized = JSON.stringify(expiredBody);
    expect(serialized).not.toContain(employeeEmail);
    expect(serialized).not.toContain(account.id);
    expect(serialized).not.toContain("demo.local");

    // 已使用：另開一個帳號走完整流程。
    const second = await createAccount();
    expect((await completeSetup(second.token)).status).toBe(200);
    const reused = await exports.default.fetch(`https://example.com/api/auth/password-setup/${second.token}`);
    expect(reused.status).toBe(410);
    const reusedBody = await reused.json<Envelope<never>>();
    expect(reusedBody.error?.message).toContain("使用過");
    expect(JSON.stringify(reusedBody)).not.toContain(second.employeeEmail);
  });

  it("帳號被停用後連結立即失效，且不透露帳號狀態", async () => {
    const { account, token, employeeEmail } = await createAccount();
    await call(`/api/admin/users/${account.id}`, adminJson("PATCH", { active: false }));

    const response = await exports.default.fetch(`https://example.com/api/auth/password-setup/${token}`);
    expect(response.status).toBe(410);
    const body = await response.json<Envelope<never>>();
    expect(JSON.stringify(body)).not.toContain(employeeEmail);
    expect(body.error?.message).not.toContain("停用");

    expect((await completeSetup(token)).status).toBe(410);
  });
});

describe("設定密碼（POST /api/auth/password-setup）", () => {
  it("公開端點：未登入即可設定，設定後即可登入且不再要求變更密碼", async () => {
    const { account, employeeEmail, token } = await createAccount();
    expect(account.mustChangePassword).toBe(true);

    // 設定之前登不進來：帳號的密碼是一組沒有人知道的隨機值。
    expect((await loginRaw(employeeEmail, SETUP_PASSWORD)).status).toBe(401);

    const done = await completeSetup(token);
    expect(done.status).toBe(200);
    const doneBody = await done.json<Envelope<{ success: boolean; message: string }>>();
    expect(doneBody.data?.success).toBe(true);

    const login = await loginRaw(employeeEmail, SETUP_PASSWORD);
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const me = await call<{ user: { mustChangePassword: boolean } }>("/api/auth/me", {
      headers: { Cookie: cookie },
    });
    // 密碼是本人設定的，沒有理由再強迫改一次。
    expect(me.body.data?.user.mustChangePassword).toBe(false);
  });

  it("單次使用：第二次一律 410，且不會再次改動密碼", async () => {
    const { employeeEmail, token } = await createAccount();
    expect((await completeSetup(token)).status).toBe(200);

    const second = await completeSetup(token, "SecondAttempt9876!");
    expect(second.status).toBe(410);
    const body = await second.json<Envelope<never>>();
    expect(body.error?.message).toContain("使用過");

    // 第二次的密碼沒有生效，第一次的仍然有效。
    expect((await loginRaw(employeeEmail, "SecondAttempt9876!")).status).toBe(401);
    expect((await loginRaw(employeeEmail, SETUP_PASSWORD)).status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT used_at AS usedAt FROM password_setup_tokens WHERE token_hash = ?",
    ).bind(await sha256Hex(token)).first<{ usedAt: string | null }>();
    expect(row?.usedAt).toBeTruthy();
  });

  it("過期的 token 無法設定密碼", async () => {
    const { employeeEmail, token } = await createAccount();
    await env.DB.prepare("UPDATE password_setup_tokens SET expires_at = ? WHERE token_hash = ?")
      .bind("2020-01-01T00:00:00.000Z", await sha256Hex(token)).run();

    const response = await completeSetup(token);
    expect(response.status).toBe(410);
    expect((await loginRaw(employeeEmail, SETUP_PASSWORD)).status).toBe(401);
  });

  it("弱密碼被 assertPasswordStrength 擋下（422），且 token 仍然可用", async () => {
    const { employeeEmail, token } = await createAccount();
    for (const weak of ["short1!A", "alllowercase1!", "NOLOWERCASE1!", "NoDigitsHere!!", "NoSymbol12345"]) {
      const response = await completeSetup(token, weak);
      expect(response.status, weak).toBe(422);
    }
    // 被擋下不該消耗連結，否則使用者打錯一次就得重新申請。
    const stillValid = await env.DB.prepare(
      "SELECT used_at AS usedAt FROM password_setup_tokens WHERE token_hash = ?",
    ).bind(await sha256Hex(token)).first<{ usedAt: string | null }>();
    expect(stillValid?.usedAt).toBeNull();
    expect((await completeSetup(token)).status).toBe(200);
    expect((await loginRaw(employeeEmail, SETUP_PASSWORD)).status).toBe(200);
  });

  it("缺少欄位回 422，token 不存在回 404", async () => {
    expect((await exports.default.fetch(
      "https://example.com/api/auth/password-setup",
      publicJson({ newPassword: SETUP_PASSWORD }),
    )).status).toBe(422);
    expect((await exports.default.fetch(
      "https://example.com/api/auth/password-setup",
      publicJson({ token: "abc" }),
    )).status).toBe(422);
    expect((await completeSetup("this-token-does-not-exist")).status).toBe(404);
  });

  it("設定成功後該帳號所有既有 session 立即失效", async () => {
    const { account, employeeEmail, token } = await createAccount();
    expect((await completeSetup(token)).status).toBe(200);

    // 模擬「帳號正被他人登入」：先登入拿到有效 cookie。
    const login = await loginRaw(employeeEmail, SETUP_PASSWORD);
    expect(login.status).toBe(200);
    const stolenCookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect((await call("/api/auth/me", { headers: { Cookie: stolenCookie } })).response.status).toBe(200);
    expect(await sessionCount(account.id)).toBe(1);

    // 本人透過忘記密碼／管理員重設拿到新連結並設定新密碼。
    const reset = await call<Account>(`/api/admin/users/${account.id}/reset-password`, adminJson("POST"));
    const freshToken = tokenFrom(reset.body.data?.setupUrl);
    expect((await completeSetup(freshToken, "AfterTakeover4321!")).status).toBe(200);

    // 對方的 cookie 必須當場失效，而不是等它自然過期。
    expect(await sessionCount(account.id)).toBe(0);
    expect((await call("/api/auth/me", { headers: { Cookie: stolenCookie } })).response.status).toBe(401);
    expect((await loginRaw(employeeEmail, "AfterTakeover4321!")).status).toBe(200);
  });
});

describe("忘記密碼（POST /api/auth/forgot-password）", () => {
  it("存在與不存在的 email 回應完全相同（狀態碼與 body 逐字相同）", async () => {
    const { employeeEmail } = await createAccount();

    const existing = await exports.default.fetch(
      "https://example.com/api/auth/forgot-password",
      publicJson({ email: employeeEmail }),
    );
    const missing = await exports.default.fetch(
      "https://example.com/api/auth/forgot-password",
      publicJson({ email: "definitely.not.here@demo.local" }),
    );

    expect(existing.status).toBe(200);
    expect(missing.status).toBe(200);
    // 逐字比對：任何差異都是帳號列舉的旁路。
    expect(await existing.text()).toBe(await missing.text());
  });

  it("停用帳號、封存帳號、格式錯誤的 email 也回同一句", async () => {
    const { account, employeeEmail } = await createAccount();
    await call(`/api/admin/users/${account.id}`, adminJson("PATCH", { active: false }));

    const baseline = await (await exports.default.fetch(
      "https://example.com/api/auth/forgot-password",
      publicJson({ email: "nobody@demo.local" }),
    )).text();

    // 清掉建立帳號時就發出的那張連結，後面才量得到「忘記密碼有沒有再發一張」。
    await env.DB.prepare("DELETE FROM password_setup_tokens WHERE user_id = ?").bind(account.id).run();

    for (const email of [employeeEmail, "not-an-email", "someone@example.org"]) {
      const response = await exports.default.fetch(
        "https://example.com/api/auth/forgot-password",
        publicJson({ email }),
      );
      expect(response.status, email).toBe(200);
      expect(await response.text(), email).toBe(baseline);
    }

    // 停用的帳號不該真的產生連結——回應一樣，但實際上什麼都沒發生。
    const tokens = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM password_setup_tokens WHERE user_id = ?",
    ).bind(account.id).first<{ count: number }>();
    expect(tokens?.count).toBe(0);
  });

  it("有效帳號會實際產生 password_reset 用途的連結，且回應不含任何連結", async () => {
    const { account, employeeEmail, token } = await createAccount();
    expect((await completeSetup(token)).status).toBe(200);

    const response = await exports.default.fetch(
      "https://example.com/api/auth/forgot-password",
      publicJson({ email: employeeEmail }),
    );
    const text = await response.text();
    // 公開端點絕不可回傳 setupUrl，否則任何人輸入別人的 email 就能拿到對方的連結。
    expect(text).not.toContain("setup=");
    expect(text.toLowerCase()).not.toContain("setupurl");

    const row = await env.DB.prepare(`
      SELECT purpose, used_at AS usedAt FROM password_setup_tokens
      WHERE user_id = ? AND used_at IS NULL
    `).bind(account.id).first<{ purpose: string; usedAt: string | null }>();
    expect(row?.purpose).toBe("password_reset");

    // email 大小寫不同也要找得到帳號。
    const upper = await exports.default.fetch(
      "https://example.com/api/auth/forgot-password",
      publicJson({ email: employeeEmail.toUpperCase() }),
    );
    expect(upper.status).toBe(200);
    expect(await upper.text()).toBe(text);
  });

  it("email 缺漏時回 422（與帳號是否存在無關，不構成列舉）", async () => {
    const response = await exports.default.fetch(
      "https://example.com/api/auth/forgot-password",
      publicJson({}),
    );
    expect(response.status).toBe(422);
  });
});

describe("連結網址來源（app_base_url，非 Host header）", () => {
  it("app_base_url 未設定時不寄信，改回傳相對路徑的 setupUrl 供管理員轉達", async () => {
    await setAppBaseUrl("");
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const { account } = await createAccount();
    expect(account.mail.status).toBe("skipped");
    expect(account.mail.message).toContain("app_base_url");
    expect(account.setupUrl?.startsWith("/?setup=")).toBe(true);
    // 沒有網址就不寄信：寧可不寄，也不要寄出指向錯誤網域的密碼設定信。
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("設定 app_base_url 後連結用該網域，且完全不受偽造的 Host 影響", async () => {
    await setAppBaseUrl("https://hr.example.com");
    // 用攻擊者網域當請求的 host（Pages 上等同偽造 Host header）。
    const response = await exports.default.fetch("https://evil.attacker.test/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ employeeId: (await createEmployee()).id, role: "employee" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json<Envelope<Account>>();
    const setupUrl = body.data?.setupUrl ?? "";
    expect(setupUrl.startsWith("https://hr.example.com/?setup=")).toBe(true);
    expect(setupUrl).not.toContain("attacker");
    expect(setupUrl).not.toContain("evil");
  });

  it("PATCH /api/admin/settings 會擋下不合法的 app_base_url 並正規化結尾斜線", async () => {
    for (const bad of ["javascript:alert(1)", "hr.example.com", "https://hr.example.com/app"]) {
      const rejected = await call("/api/admin/settings", adminJson("PATCH", {
        updates: [{ key: "app_base_url", value: bad }],
      }));
      expect(rejected.response.status, bad).toBe(422);
    }
    const ok = await call<{ settings: Array<{ key: string; value: string }> }>(
      "/api/admin/settings",
      adminJson("PATCH", { updates: [{ key: "app_base_url", value: "https://hr.example.com/" }] }),
    );
    expect(ok.response.status).toBe(200);
    expect(ok.body.data?.settings.find((s) => s.key === "app_base_url")?.value).toBe("https://hr.example.com");
  });
});

describe("有效時數設定（password_setup_token_hours）", () => {
  it("依設定值換算到期時間，1～72 以外的值退回預設 24", async () => {
    await setTokenHours("1");
    expect(await passwordSetupHours(env.DB)).toBe(1);
    await setTokenHours("72");
    expect(await passwordSetupHours(env.DB)).toBe(72);
    // 讀取端不能假設 settings 一定合法（多支端點都能寫）。
    for (const invalid of ["0", "73", "-5", "abc", "24.5", ""]) {
      await setTokenHours(invalid);
      expect(await passwordSetupHours(env.DB), invalid).toBe(24);
    }
  });

  it("PATCH /api/admin/settings 擋下 1～72 以外的值", async () => {
    for (const bad of [0, 73, 24.5]) {
      const response = await call("/api/admin/settings", adminJson("PATCH", {
        updates: [{ key: "password_setup_token_hours", value: bad }],
      }));
      expect(response.response.status, String(bad)).toBe(422);
    }
    expect((await call("/api/admin/settings", adminJson("PATCH", {
      updates: [{ key: "password_setup_token_hours", value: 6 }],
    }))).response.status).toBe(200);
  });

  it("expiresAt 反映設定的時數", async () => {
    await setTokenHours("2");
    const { account } = await createAccount();
    const info = await call<TokenInfo>(`/api/auth/password-setup/${tokenFrom(account.setupUrl)}`);
    const hours = (new Date(info.body.data?.expiresAt ?? 0).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(1.9);
    expect(hours).toBeLessThan(2.1);
  });
});

describe("信件內容", () => {
  /** password_setup_tokens.user_id 有外鍵，直呼 issuePasswordSetup 必須帶真實帳號。 */
  async function anyUserId(): Promise<string> {
    const row = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
      .bind("admin@demo.local").first<{ id: string }>();
    if (!row) throw new Error("找不到種子帳號");
    return row.id;
  }

  it("寄出的信含連結與有效時數，不含任何密碼；寄出成功則不回傳 setupUrl", async () => {
    await setAppBaseUrl("https://hr.example.com");
    await setTokenHours("6");
    const sent = vi.fn(async () => new Response(JSON.stringify({ message_id: "m-1" }), { status: 200 }));
    vi.stubGlobal("fetch", sent);

    const delivery = await issuePasswordSetup(
      { AGENTMAIL_API_KEY: "k", AGENTMAIL_INBOX_ID: "inbox@agentmail.to" },
      env.DB,
      { id: await anyUserId(), email: "someone@demo.local" },
      "account_setup",
    );

    expect(delivery.mail.status).toBe("sent");
    // 寄出成功就不再把連結留在 API 回應裡。
    expect(delivery.setupUrl).toBeUndefined();

    const [, init] = sent.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as { subject: string; text: string };
    expect(payload.text).toContain("https://hr.example.com/?setup=");
    expect(payload.text).toContain("6 小時");
    expect(payload.text).toContain("僅能使用一次");
    // 信裡沒有密碼——這正是改用連結取代臨時密碼的全部理由。
    // 「密碼：」後面同一行不得再接任何東西（那就是在信裡直接給值）。
    expect(payload.text).not.toMatch(/密碼[:：][ \t]*\S/);
    expect(payload.text).toContain("不會、也不應在信件中提供或索取您的密碼");
    expect(payload.subject).toContain("人資系統");
  });

  it("寄信失敗時不拋例外，改回傳 setupUrl 讓管理員手動轉達", async () => {
    await setAppBaseUrl("https://hr.example.com");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    const delivery = await issuePasswordSetup(
      { AGENTMAIL_API_KEY: "k", AGENTMAIL_INBOX_ID: "inbox@agentmail.to" },
      env.DB,
      { id: await anyUserId(), email: "someone@demo.local" },
      "password_reset",
    );
    expect(delivery.mail.status).toBe("failed");
    expect(delivery.setupUrl?.startsWith("https://hr.example.com/?setup=")).toBe(true);
  });
});
