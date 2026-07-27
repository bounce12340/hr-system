import { afterEach, describe, expect, it, vi } from "vitest";
import { describeMailResult, isMailerConfigured, sendMail } from "../src/server/mailer";

// 寄信是「盡力而為」的附帶動作：帳號已經建立成功，不該因為通知信寄不出去就
// 讓整個請求失敗。因此這裡的重點不是「有沒有寄成功」，而是**各種失敗情境下
// 都必須回傳結果物件而非拋例外**——一旦拋例外，呼叫端會誤判主流程失敗而重試，
// 反而製造重複資料。

const ENV = { AGENTMAIL_API_KEY: "test-key", AGENTMAIL_INBOX_ID: "inbox@agentmail.to" };
const MESSAGE = { to: "someone@example.com", subject: "測試", text: "內容" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isMailerConfigured", () => {
  it("兩個值都有才算已設定", () => {
    expect(isMailerConfigured(ENV)).toBe(true);
    expect(isMailerConfigured({ AGENTMAIL_API_KEY: "k" })).toBe(false);
    expect(isMailerConfigured({ AGENTMAIL_INBOX_ID: "i" })).toBe(false);
    expect(isMailerConfigured({})).toBe(false);
    expect(isMailerConfigured(undefined)).toBe(false);
  });
});

describe("sendMail", () => {
  it("未設定時略過而非報錯，且完全不發出請求", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await sendMail({}, MESSAGE);
    expect(result.status).toBe("skipped");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("成功時回傳 sent 與 messageId", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ message_id: "msg-123" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));
    const result = await sendMail(ENV, MESSAGE);
    expect(result).toEqual({ status: "sent", messageId: "msg-123" });
  });

  it("送出正確的 endpoint、Bearer 標頭與 body", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await sendMail(ENV, { ...MESSAGE, cc: "cc@example.com", replyTo: "reply@example.com" });

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.agentmail.to/v0/inboxes/inbox%40agentmail.to/messages/send");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      to: "someone@example.com",
      subject: "測試",
      text: "內容",
      cc: "cc@example.com",
      reply_to: "reply@example.com",
    });
    // 未提供的欄位不應以 undefined 送出。
    expect("html" in body).toBe(false);
    expect("bcc" in body).toBe(false);
  });

  it("服務回非 2xx 時回傳 failed，不拋例外，且不外洩供應商原始回應", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "invalid api key for inbox xyz" }),
      { status: 401 },
    )));
    const result = await sendMail(ENV, MESSAGE);
    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.reason).toContain("401");
    // 原始回應可能夾帶請求內容或帳號資訊，不應轉述。
    expect(JSON.stringify(result)).not.toContain("invalid api key");
  });

  it("連線失敗時回傳 failed 而非拋例外", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network down"); }));
    const result = await sendMail(ENV, MESSAGE);
    expect(result.status).toBe("failed");
  });

  it("回應非 JSON 也不應拋例外", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("OK", { status: 200 })));
    const result = await sendMail(ENV, MESSAGE);
    expect(result).toEqual({ status: "sent", messageId: null });
  });

  it("inbox id 含非法字元時拒絕，避免路徑跳脫", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await sendMail(
      { ...ENV, AGENTMAIL_INBOX_ID: "../../admin/secrets" },
      MESSAGE,
    );
    expect(result.status).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("回傳結果都有對應的中文說明", () => {
    expect(describeMailResult({ status: "sent", messageId: "a" })).toContain("已寄出");
    expect(describeMailResult({ status: "skipped", reason: "x" })).toContain("未設定");
    expect(describeMailResult({ status: "failed", reason: "逾時。" })).toContain("失敗");
  });
});
