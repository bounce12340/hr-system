import { ApiError, json, parseJson, requireAdmin } from "./http";
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

function coerceIn(value: unknown, valueType: ValueType, key: string): string {
  switch (valueType) {
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new ApiError(422, `設定「${key}」須為數字。`);
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
      return trimmed;
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

export async function handleAdminSettings(context: ApiContext, path: string): Promise<Response | null> {
  requireAdmin(context.user);
  if (path !== "/api/admin/settings") return null;
  if (context.request.method === "GET") {
    return json({ settings: await listSettings(context.env.DB) });
  }
  if (context.request.method === "PATCH") {
    return updateSettings(context);
  }
  return null;
}
