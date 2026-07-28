import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/server/http";
import { assertHuman, isTurnstileEnabled, turnstileSiteKey } from "../src/server/turnstile";

// 這裡真正要守住的性質有三個，缺一整套防護就等於沒有：
//   1. 未設定金鑰時完全略過（否則本機與 CI 全部登不進去）。
//   2. 設定後，任何無法確認「是真人」的情況都必須擋下——包含 siteverify 連不上。
//   3. 驗證發生在密碼比對**之前**（否則機器人照樣能把 PBKDF2 的 CPU 吃光）。
// 前兩點用單元測試，第三點用打真實端點的整合測試。

const ENV = {
  TURNSTILE_SITE_KEY: "0x4AAAAAAATestSiteKey",
  TURNSTILE_SECRET_KEY: "0x4AAAAAAATestSecretKey",
};

const REQUEST = new Request("https://example.com/api/auth/login", { method: "POST" });

function siteverifyReplying(payload: unknown, status = 200): ReturnType<typeof vi.fn> {
  return vi.fn(async () => new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  }));
}

/** 取出 ApiError 的狀態碼；沒拋錯就讓測試明確失敗，而不是靜靜通過。 */
async function statusOfThrown(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (caught) {
    if (caught instanceof ApiError) return caught.status;
    throw caught;
  }
  throw new Error("預期會拋出 ApiError，但呼叫順利完成了。");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("turnstileSiteKey／isTurnstileEnabled", () => {
  it("兩把金鑰都有才算啟用，只設一半一律視為未啟用", () => {
    expect(turnstileSiteKey(ENV)).toBe(ENV.TURNSTILE_SITE_KEY);
    expect(isTurnstileEnabled(ENV)).toBe(true);

    // 只有 site key：畫面有驗證框、後端不驗，是假防護。
    expect(turnstileSiteKey({ TURNSTILE_SITE_KEY: "k" })).toBeNull();
    // 只有 secret：前端產不出 token，所有人都登不進來。
    expect(turnstileSiteKey({ TURNSTILE_SECRET_KEY: "s" })).toBeNull();
    expect(turnstileSiteKey({})).toBeNull();
    expect(turnstileSiteKey(undefined)).toBeNull();
  });
});

describe("assertHuman", () => {
  it("未設定金鑰時直接放行，且完全不發出請求", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(assertHuman(REQUEST, {}, undefined)).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("只設定 site key 時同樣放行——與 turnstileSiteKey 的判斷必須一致", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(assertHuman(REQUEST, { TURNSTILE_SITE_KEY: "k" }, undefined)).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("已啟用但沒帶 token 時擋下，且不浪費一次 siteverify 呼叫", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const token of [undefined, null, "", "   ", 123, {}]) {
      expect(await statusOfThrown(assertHuman(REQUEST, ENV, token))).toBe(403);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("siteverify 回 success 時放行", async () => {
    vi.stubGlobal("fetch", siteverifyReplying({ success: true, action: "turnstile-spin-v1" }));
    await expect(assertHuman(REQUEST, ENV, "token")).resolves.toBeUndefined();
  });

  it("siteverify 回 success:false 時擋下", async () => {
    vi.stubGlobal("fetch", siteverifyReplying({ success: false, "error-codes": ["timeout-or-duplicate"] }));
    expect(await statusOfThrown(assertHuman(REQUEST, ENV, "token"))).toBe(403);
  });

  it("不把 siteverify 的 error-codes 轉述給使用者", async () => {
    // timeout-or-duplicate 會告訴攻擊者這個 token 是不是已經被用過。
    vi.stubGlobal("fetch", siteverifyReplying({ success: false, "error-codes": ["timeout-or-duplicate"] }));
    try {
      await assertHuman(REQUEST, ENV, "token");
      throw new Error("預期會被擋下。");
    } catch (caught) {
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).message).not.toContain("timeout-or-duplicate");
    }
  });

  it("action 不符時擋下", async () => {
    vi.stubGlobal("fetch", siteverifyReplying({ success: true, action: "some-other-form" }));
    expect(await statusOfThrown(assertHuman(REQUEST, ENV, "token"))).toBe(403);
  });

  it("回應未帶 action 時仍放行——Cloudflare 測試用 secret 回的合成回應沒有這個欄位", async () => {
    vi.stubGlobal("fetch", siteverifyReplying({ success: true }));
    await expect(assertHuman(REQUEST, ENV, "token")).resolves.toBeUndefined();
  });

  it("siteverify 連不上時擋下（fail closed），並用 503 與「驗證未通過」區分", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network down"); }));
    expect(await statusOfThrown(assertHuman(REQUEST, ENV, "token"))).toBe(503);
  });

  it("siteverify 回非 2xx 時擋下", async () => {
    vi.stubGlobal("fetch", siteverifyReplying({}, 500));
    expect(await statusOfThrown(assertHuman(REQUEST, ENV, "token"))).toBe(503);
  });

  it("回應不是合法 JSON 時擋下，而不是當成通過", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>maintenance</html>", { status: 200 })));
    expect(await statusOfThrown(assertHuman(REQUEST, ENV, "token"))).toBe(503);
  });

  it("送出正確的 endpoint 與表單欄位，並帶上來源 IP", async () => {
    const fetchSpy = siteverifyReplying({ success: true });
    vi.stubGlobal("fetch", fetchSpy);
    const request = new Request("https://example.com/api/auth/login", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.9" },
    });
    await assertHuman(request, ENV, "the-token");

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const form = init.body as URLSearchParams;
    expect(form.get("secret")).toBe(ENV.TURNSTILE_SECRET_KEY);
    expect(form.get("response")).toBe("the-token");
    expect(form.get("remoteip")).toBe("203.0.113.9");
  });

  it("沒有來源 IP 時不送出空字串的 remoteip", async () => {
    const fetchSpy = siteverifyReplying({ success: true });
    vi.stubGlobal("fetch", fetchSpy);
    await assertHuman(REQUEST, ENV, "the-token");
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.body as URLSearchParams).has("remoteip")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 整合：打真正的端點，驗證路由確實接上了
// ---------------------------------------------------------------------------

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { message: string };
}

async function callApi<T>(path: string, init?: RequestInit): Promise<{ response: Response; body: Envelope<T> }> {
  const response = await exports.default.fetch(`https://example.com${path}`, init);
  return { response, body: await response.json<Envelope<T>>() };
}

function postJson(path: string, payload: unknown) {
  return callApi(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** 測試環境的 env 沒有 Turnstile 金鑰；用完務必還原，否則污染同檔其他測試。 */
function withTurnstileEnabled(): () => void {
  const target = env as unknown as Record<string, string | undefined>;
  target.TURNSTILE_SITE_KEY = ENV.TURNSTILE_SITE_KEY;
  target.TURNSTILE_SECRET_KEY = ENV.TURNSTILE_SECRET_KEY;
  return () => {
    delete target.TURNSTILE_SITE_KEY;
    delete target.TURNSTILE_SECRET_KEY;
  };
}

describe("端點整合", () => {
  it("未啟用時 /api/public-config 回 null，登入不受影響", async () => {
    const { response, body } = await callApi<{ turnstileSiteKey: string | null }>("/api/public-config");
    expect(response.status).toBe(200);
    expect(body.data?.turnstileSiteKey).toBeNull();

    const login = await postJson("/api/auth/login", { email: "admin@demo.local", password: "Demo1234!" });
    expect(login.response.status).toBe(200);
  });

  it("啟用時 /api/public-config 交出 site key，但絕不交出 secret", async () => {
    const restore = withTurnstileEnabled();
    try {
      const { body } = await callApi<{ turnstileSiteKey: string | null }>("/api/public-config");
      expect(body.data?.turnstileSiteKey).toBe(ENV.TURNSTILE_SITE_KEY);
      expect(JSON.stringify(body)).not.toContain(ENV.TURNSTILE_SECRET_KEY);
    } finally {
      restore();
    }
  });

  it("啟用時，帳密完全正確但沒帶 token 也登不進去", async () => {
    const restore = withTurnstileEnabled();
    try {
      const { response, body } = await postJson("/api/auth/login", {
        email: "admin@demo.local",
        password: "Demo1234!",
      });
      expect(response.status).toBe(403);
      expect(body.error?.message).toContain("人機驗證");
    } finally {
      restore();
    }
  });

  it("啟用時，密碼錯誤且沒帶 token 要回 403 而非 401——證明驗證擋在密碼比對之前", async () => {
    // 這條是整組測試裡最重要的一條。若回 401，代表系統是先算了 PBKDF2 十萬輪
    // 才發現沒過人機驗證：猜密碼會被擋，但「讓伺服器做白工」這個攻擊面還在，
    // 而那正是速率限制／Turnstile 要解決的問題。
    const restore = withTurnstileEnabled();
    try {
      const { response } = await postJson("/api/auth/login", {
        email: "admin@demo.local",
        password: "definitely-the-wrong-password",
      });
      expect(response.status).toBe(403);
    } finally {
      restore();
    }
  });

  it("啟用時，忘記密碼沒帶 token 也會被擋，不會寄出任何信", async () => {
    const restore = withTurnstileEnabled();
    try {
      const { response } = await postJson("/api/auth/forgot-password", { email: "admin@demo.local" });
      expect(response.status).toBe(403);
    } finally {
      restore();
    }
  });

  it("啟用時，連 email 欄位都沒有也是 403——驗證先於欄位檢查", async () => {
    const restore = withTurnstileEnabled();
    try {
      const { response } = await postJson("/api/auth/login", {});
      expect(response.status).toBe(403);
    } finally {
      restore();
    }
  });
});
