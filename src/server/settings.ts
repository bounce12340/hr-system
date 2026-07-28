import { ApiError, json, parseJson, requireAdmin, requiredString } from "./http";
import { describeMailResult, isMailerConfigured, sendMail } from "./mailer";
import { isTurnstileEnabled } from "./turnstile";
import type { ApiContext } from "./types";

/**
 * 系統設定統一入口（規格 §七）。`settings` 表本身已被 M2 的
 * `/api/admin/training-settings`（見 m2.ts:865-868）與 M3 的
 * `/api/admin/recruitment/probation-settings`（見 m3.ts）各自讀寫其中幾個 key。
 * 這支端點涵蓋整張表的所有 key，寫入語意同樣是「UPDATE 既有列」，
 * 不會新增／刪除列，因此與既有兩支端點是同一份資料的不同入口，不會互相打架，
 * 最後寫入者生效（一般 key-value 設定的標準行為）。
 */

type ValueType = "string" | "number" | "boolean" | "json";

interface SettingRow {
  key: string;
  value: string;
  valueType: ValueType;
  description: string;
}

export interface PublicSetting {
  key: string;
  value: string;
  valueType: ValueType;
  description: string;
}

interface SettingsUpdateInput {
  updates?: unknown;
}

interface UpdateItem {
  key: string;
  value: unknown;
}

/**
 * value 刻意回傳資料庫原始字串，不在後端轉型。
 * 前端（src/client/types.ts 的 SettingItem.value: string／
 * src/client/pages/SettingsAdminPages.tsx 的 parseSettingValue）已依此開發，
 * 自行依 valueType 把字串轉成畫面要的 number／boolean；valueType 只是渲染提示。
 */
async function listSettings(db: D1Database): Promise<PublicSetting[]> {
  const result = await db.prepare(`
    SELECT setting_key AS key, setting_value AS value, value_type AS valueType, description
    FROM settings
    ORDER BY setting_key
  `).all<SettingRow>();
  return result.results;
}

/**
 * 少數設定有業務上的硬性範圍，必須在這支「什麼 key 都能寫」的統一入口一併把關，
 * 否則使用者可從這裡繞過各模組專屬端點的驗證（例如 m3 的 probation-settings）。
 * 只列真正有範圍限制的 key；未列出者維持原本只驗型別的行為。
 */
const NUMBER_RANGES: Record<string, { min: number; max: number }> = {
  // 健檢提前提醒月數，需求明訂限制 1～3（migrations/0011_health_check.sql）。
  health_check_reminder_months: { min: 1, max: 3 },
  // 密碼設定連結有效時數，需求明訂限制 1～72（migrations/0012_password_setup_tokens.sql）。
  password_setup_token_hours: { min: 1, max: 72 },
};

/**
 * 少數字串設定除了長度以外還有格式要求。回傳正規化後的值（會被寫入資料庫）。
 * 空字串一律代表「未設定」，必須放行——app_base_url 就是靠空值來表達
 * 「還沒設定對外網址，不要寄信」。
 */
const STRING_NORMALIZERS: Record<string, (value: string, key: string) => string> = {
  /**
   * 系統對外網址。這個值會被拿去組密碼設定連結（password-setup.ts），
   * 也就是使用者會在上面輸入新密碼的網域，因此格式必須嚴格把關：
   *   - 只接受 http／https，擋掉 javascript: 這類會變成 XSS 的 scheme。
   *   - 不接受路徑／query／fragment：連結格式固定是 `{app_base_url}/?setup={token}`，
   *     多出來的部分只會組出打不開的網址。
   *   - 去掉結尾斜線，避免組出 `//?setup=`。
   */
  app_base_url: (value, key) => {
    if (value === "") return "";
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new ApiError(422, `設定「${key}」須為完整網址，例如 https://hr.example.com。`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new ApiError(422, `設定「${key}」只接受 http:// 或 https:// 開頭的網址。`);
    }
    if (parsed.search || parsed.hash || parsed.pathname.replace(/\/+$/, "") !== "") {
      throw new ApiError(422, `設定「${key}」只能填網域（例如 https://hr.example.com），不可包含路徑或參數。`);
    }
    return `${parsed.protocol}//${parsed.host}`;
  },
};

function coerceIn(value: unknown, valueType: ValueType, key: string): string {
  switch (valueType) {
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new ApiError(422, `設定「${key}」須為數字。`);
      }
      const range = NUMBER_RANGES[key];
      if (range && (!Number.isInteger(value) || value < range.min || value > range.max)) {
        throw new ApiError(422, `設定「${key}」須為 ${range.min}～${range.max} 的整數。`);
      }
      return String(value);
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        throw new ApiError(422, `設定「${key}」須為布林值（開／關）。`);
      }
      return value ? "true" : "false";
    }
    case "json": {
      if (value === undefined) {
        throw new ApiError(422, `設定「${key}」缺少 value。`);
      }
      try {
        return JSON.stringify(value);
      } catch {
        throw new ApiError(422, `設定「${key}」格式不正確。`);
      }
    }
    default: {
      if (typeof value !== "string") {
        throw new ApiError(422, `設定「${key}」須為文字。`);
      }
      const trimmed = value.trim();
      if (trimmed.length > 2000) {
        throw new ApiError(422, `設定「${key}」不可超過 2000 字。`);
      }
      return STRING_NORMALIZERS[key]?.(trimmed, key) ?? trimmed;
    }
  }
}

function parseUpdates(body: SettingsUpdateInput): UpdateItem[] {
  if (!Array.isArray(body.updates) || body.updates.length === 0) {
    throw new ApiError(422, "updates 須為至少一筆的陣列。");
  }
  return body.updates.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ApiError(422, `第 ${index + 1} 筆設定格式不正確。`);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.key !== "string" || record.key.trim() === "") {
      throw new ApiError(422, `第 ${index + 1} 筆設定缺少 key。`);
    }
    if (!("value" in record)) {
      throw new ApiError(422, `設定「${record.key}」缺少 value。`);
    }
    return { key: record.key.trim(), value: record.value };
  });
}

/**
 * 批次更新設定。先整批查出既有 key／valueType 並驗證完畢，通過後才組 batch 寫入，
 * 避免部份成功部份失敗；任何 key 不存在一律 404，型別不符一律 422。
 */
async function updateSettings(context: ApiContext): Promise<Response> {
  const body = await parseJson<SettingsUpdateInput>(context.request);
  const updates = parseUpdates(body);

  const existing = await context.env.DB.prepare(`
    SELECT setting_key AS key, value_type AS valueType FROM settings
  `).all<{ key: string; valueType: ValueType }>();
  const typeByKey = new Map(existing.results.map((row) => [row.key, row.valueType]));

  const statements = updates.map((update) => {
    const valueType = typeByKey.get(update.key);
    if (!valueType) throw new ApiError(404, `找不到設定項目「${update.key}」。`);
    const stored = coerceIn(update.value, valueType, update.key);
    return context.env.DB.prepare(`
      UPDATE settings SET setting_value = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE setting_key = ?
    `).bind(stored, update.key);
  });

  await context.env.DB.batch(statements);
  return json({ settings: await listSettings(context.env.DB) });
}

/**
 * 寄送測試信，用來驗證 AGENTMAIL_API_KEY／AGENTMAIL_INBOX_ID 是否設定正確。
 *
 * 存在理由：這兩個值是加密的 secret，設定後無法讀回檢查，出錯時也只會在實際
 * 寄信的當下才浮現。與其等到建立帳號時才發現通知信寄不出去，不如提供一個
 * 可主動驗證的入口；日後輪替金鑰同樣用得到。
 *
 * 回應一律 200，實際結果放在 body。寄信失敗是「設定有問題」而非「請求有問題」，
 * 用 4xx／5xx 會讓前端難以區分是端點壞了還是設定壞了。
 */
async function sendTestMail(context: ApiContext): Promise<Response> {
  const body = await parseJson<{ to?: unknown }>(context.request);
  const to = requiredString(body.to, "收件者", 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    throw new ApiError(422, "收件者 Email 格式不正確。");
  }
  const result = await sendMail(context.env, {
    to,
    subject: "人資系統寄信設定測試",
    text: "這是一封測試信。\n\n收到這封信代表人資系統的寄信設定正確，可以正常發送通知。",
  });
  return json({ result, message: describeMailResult(result), configured: isMailerConfigured(context.env) });
}

export async function handleAdminSettings(context: ApiContext, path: string): Promise<Response | null> {
  requireAdmin(context.user);
  if (path === "/api/admin/settings/mail-test" && context.request.method === "POST") {
    return sendTestMail(context);
  }
  if (path !== "/api/admin/settings") return null;
  if (context.request.method === "GET") {
    return json({
      settings: await listSettings(context.env.DB),
      // 讓設定頁能顯示寄信服務是否就緒，而不必等到實際寄信才知道。
      mailerConfigured: isMailerConfigured(context.env),
      // 同理。Turnstile 需要 site key 與 secret key 成對才會啟用，只設一半會
      // 靜默退回未啟用（見 turnstile.ts）；沒有這個顯示，管理者會以為已經有
      // 防護。
      turnstileConfigured: isTurnstileEnabled(context.env),
    });
  }
  if (context.request.method === "PATCH") {
    return updateSettings(context);
  }
  return null;
}
