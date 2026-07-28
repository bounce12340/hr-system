import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

// 這個檔案守兩件事：
//   1. 新手導覽的「已看過」狀態確實存進資料庫，而且只寫一次。
//   2. 員工的生日在編輯時不會被清掉——後端 PATCH 是全量取代，前端一旦漏送
//      這個欄位就會靜默資料遺失（健檢頻率依年齡分級，沒生日等於停止提醒）。

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { message: string };
}

async function callApi<T>(path: string, init?: RequestInit): Promise<{ response: Response; body: Envelope<T> }> {
  const response = await exports.default.fetch(`https://example.com${path}`, init);
  return { response, body: await response.json<Envelope<T>>() };
}

/** 只登入，不改密碼。用於驗證導覽狀態——導覽與 mustChangePassword 無關。 */
async function loginAsAdmin(): Promise<string> {
  const { response } = await callApi("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@demo.local", password: "Demo1234!" }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

/**
 * 取得可呼叫 admin API 的 session。種子帳號的 must_change_password 是 1，
 * requireAdmin 會先擋 428。
 *
 * 這裡直接在資料庫把旗標清掉，而不是走 change-password API：本檔的測試之間
 * 資料庫狀態並未回滾，改過密碼之後下一個測試就登不進來了（實測 401）。
 * 直接改旗標不動密碼，每個測試的前提才一致。
 */
async function loginAsUsableAdmin(): Promise<string> {
  await env.DB.prepare("UPDATE users SET must_change_password = 0 WHERE email = 'admin@demo.local'").run();
  return loginAsAdmin();
}

function authed(cookie: string, init?: RequestInit): RequestInit {
  return { ...init, headers: { ...(init?.headers ?? {}), "Content-Type": "application/json", cookie } };
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM sessions").run();
  await env.DB.prepare("UPDATE users SET tour_completed_at = NULL").run();
});

describe("新手導覽狀態", () => {
  it("新帳號預設為未看過導覽", async () => {
    const cookie = await loginAsAdmin();
    const { body } = await callApi<{ user: { tourCompleted: boolean } }>("/api/auth/me", authed(cookie));
    expect(body.data?.user.tourCompleted).toBe(false);
  });

  it("呼叫 tour-complete 後狀態變為已看過，且重新登入仍然保持", async () => {
    const cookie = await loginAsAdmin();
    const done = await callApi<{ user: { tourCompleted: boolean } }>(
      "/api/auth/tour-complete",
      authed(cookie, { method: "POST", body: "{}" }),
    );
    expect(done.response.status).toBe(200);
    expect(done.body.data?.user.tourCompleted).toBe(true);

    // 重新登入才是真正的驗證：狀態必須來自資料庫，而不是只存在於這次回應裡。
    const second = await loginAsAdmin();
    const { body } = await callApi<{ user: { tourCompleted: boolean } }>("/api/auth/me", authed(second));
    expect(body.data?.user.tourCompleted).toBe(true);
  });

  it("重複呼叫不會覆蓋原始完成時間", async () => {
    // 「重看導覽」不該把首次完成時間洗掉——那個時間是日後判斷「導覽改版後
    // 誰該重看」的唯一依據。
    const cookie = await loginAsAdmin();
    await callApi("/api/auth/tour-complete", authed(cookie, { method: "POST", body: "{}" }));
    const first = await env.DB.prepare(
      "SELECT tour_completed_at AS at FROM users WHERE email = 'admin@demo.local'",
    ).first<{ at: string }>();

    await callApi("/api/auth/tour-complete", authed(cookie, { method: "POST", body: "{}" }));
    const second = await env.DB.prepare(
      "SELECT tour_completed_at AS at FROM users WHERE email = 'admin@demo.local'",
    ).first<{ at: string }>();

    expect(second?.at).toBe(first?.at);
  });

  it("未登入不得呼叫", async () => {
    const { response } = await callApi("/api/auth/tour-complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });
});

describe("員工生日", () => {
  interface EmployeeRow { id: string; employeeNo: string; birthDate: string | null; name: string }

  /** 職務類型為必填，這裡只要一個合法的 id，用哪一個不影響本檔要驗的事。 */
  async function anyJobTypeId(): Promise<string> {
    const row = await env.DB.prepare("SELECT id FROM job_types LIMIT 1").first<{ id: string }>();
    expect(row?.id).toBeTruthy();
    return row?.id ?? "";
  }

  async function createEmployee(cookie: string, birthDate: string | null) {
    const { response, body } = await callApi<{ employee: EmployeeRow }>("/api/admin/employees", authed(cookie, {
      method: "POST",
      body: JSON.stringify({
        employeeNo: "E900", name: "生日測試", email: "birthday@demo.local",
        department: "人資行政部", grade: "P2", title: "專員",
        jobTypeId: await anyJobTypeId(), hireDate: "2020-01-01", birthDate, salary: null,
      }),
    }));
    return { response, body };
  }

  async function readEmployee(cookie: string, employeeNo: string): Promise<EmployeeRow | undefined> {
    const { body } = await callApi<{ employees: EmployeeRow[] }>(
      "/api/admin/employees?includeInactive=true", authed(cookie),
    );
    return body.data?.employees.find((item) => item.employeeNo === employeeNo);
  }

  it("清單回傳 birthDate，前端編輯表單才有值可回填", async () => {
    const cookie = await loginAsUsableAdmin();
    const anyone = (await callApi<{ employees: EmployeeRow[] }>(
      "/api/admin/employees?includeInactive=true", authed(cookie),
    )).body.data?.employees[0];
    // 值可能是 null（種子資料未必都有生日），但欄位本身必須存在——
    // 缺欄位時前端拿到 undefined，回填成空字串後一存檔就把資料清掉了。
    expect(anyone).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(anyone as object, "birthDate")).toBe(true);
  });

  it("PATCH 有帶 birthDate 時保留，沒帶時會被清空", async () => {
    const cookie = await loginAsUsableAdmin();
    const created = await createEmployee(cookie, "1985-03-15");
    expect(created.body.error?.message ?? "").toBe("");
    expect(created.response.status).toBe(201);
    const id = created.body.data?.employee.id;
    expect(id).toBeTruthy();

    expect((await readEmployee(cookie, "E900"))?.birthDate).toBe("1985-03-15");

    const basePayload = {
      employeeNo: "E900", name: "生日測試", email: "birthday@demo.local",
      department: "人資行政部", grade: "P2", title: "專員",
      jobTypeId: await anyJobTypeId(), hireDate: "2020-01-01", salary: null,
    };

    // 每次 PATCH 都要斷言狀態碼。少了這一步，請求若被驗證擋下（例如漏帶必填的
    // 職務類型）就根本不會寫入，而「值沒有改變」的斷言照樣會通過——測試變成
    // 空過卻看不出來。這個檔案第一版就是這樣，差點把假通過當成驗證完成。
    const withBirthDate = await callApi(`/api/admin/employees/${id}`, authed(cookie, {
      method: "PATCH",
      body: JSON.stringify({ ...basePayload, name: "改個名字", birthDate: "1985-03-15" }),
    }));
    expect(withBirthDate.response.status).toBe(200);
    expect((await readEmployee(cookie, "E900"))?.birthDate).toBe("1985-03-15");

    // 沒帶：被清空。這正是前端表單原本缺少生日欄位時發生的事——
    // 這條測試把「PATCH 是全量取代」這個容易誤解的契約釘住，避免日後有人
    // 在別處寫出同樣漏送欄位的請求。
    const withoutBirthDate = await callApi(`/api/admin/employees/${id}`, authed(cookie, {
      method: "PATCH",
      body: JSON.stringify({ ...basePayload, name: "再改一次" }),
    }));
    expect(withoutBirthDate.response.status).toBe(200);
    expect((await readEmployee(cookie, "E900"))?.birthDate).toBeNull();
  });
});
