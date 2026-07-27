/**
 * AgentMail 寄信整合。
 *
 * 憑證來源：`AGENTMAIL_API_KEY` 與 `AGENTMAIL_INBOX_ID` 兩個 Worker 環境變數。
 * 兩者**都不進版控**——正式環境用 `wrangler secret put`，本機開發放 `.dev.vars`
 * （已列入 .gitignore）。程式碼中不得出現任何金鑰字面值。
 *
 * 設計原則：
 * - **未設定時靜默停用**，而非拋錯。本機開發與測試環境沒有金鑰是常態，寄信能力
 *   缺席不該讓建立帳號、儲存資料這些主要流程失敗。
 * - **寄信失敗不可中斷主流程**。帳號已經建立成功，卻因為通知信寄不出去而回傳
 *   錯誤，會讓呼叫端誤以為整件事失敗而重試，反而製造重複帳號。因此一律回傳
 *   結果物件而非拋例外，由呼叫端決定如何呈現。
 * - **絕不記錄金鑰或信件內文**。錯誤訊息只帶狀態碼與收件者，臨時密碼這類內容
 *   不得進入 log。
 */

export interface MailMessage {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
}

export type MailResult =
  | { status: "sent"; messageId: string | null }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

/** 逾時上限。Workers 的請求時間有限，寄信卡住不該拖垮整個 API 回應。 */
const SEND_TIMEOUT_MS = 10_000;

interface MailerEnv {
  AGENTMAIL_API_KEY?: string;
  AGENTMAIL_INBOX_ID?: string;
}

/** 是否已完成設定。呼叫端可據此決定 UI 上要不要顯示「將寄送通知信」。 */
export function isMailerConfigured(env: unknown): boolean {
  const config = env as MailerEnv;
  return Boolean(config?.AGENTMAIL_API_KEY && config?.AGENTMAIL_INBOX_ID);
}

export async function sendMail(env: unknown, message: MailMessage): Promise<MailResult> {
  const config = env as MailerEnv;
  const apiKey = config?.AGENTMAIL_API_KEY;
  const inboxId = config?.AGENTMAIL_INBOX_ID;

  if (!apiKey || !inboxId) {
    return { status: "skipped", reason: "未設定 AGENTMAIL_API_KEY 或 AGENTMAIL_INBOX_ID，已略過寄信。" };
  }

  // inbox id 會直接進入 URL path，先擋掉可能造成路徑跳脫的值。
  if (!/^[A-Za-z0-9._@-]+$/.test(inboxId)) {
    return { status: "failed", reason: "AGENTMAIL_INBOX_ID 含有不允許的字元。" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inboxId)}/messages/send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: message.to,
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
          ...(message.cc ? { cc: message.cc } : {}),
          ...(message.bcc ? { bcc: message.bcc } : {}),
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      // 只帶狀態碼，不回傳供應商的原始回應——那可能夾帶請求內容。
      return { status: "failed", reason: `寄信服務回應 ${response.status}。` };
    }

    const payload = await response.json().catch(() => null) as { message_id?: string; id?: string } | null;
    return { status: "sent", messageId: payload?.message_id ?? payload?.id ?? null };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return { status: "failed", reason: aborted ? "寄信逾時。" : "無法連線至寄信服務。" };
  } finally {
    clearTimeout(timer);
  }
}

/** 供 UI 顯示的中文說明；不外洩任何憑證或內文。 */
export function describeMailResult(result: MailResult): string {
  if (result.status === "sent") return "通知信已寄出。";
  if (result.status === "skipped") return "系統未設定寄信服務，未寄送通知信。";
  return `通知信寄送失敗：${result.reason}`;
}
