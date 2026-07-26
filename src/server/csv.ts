/**
 * 共用 CSV 解析器（`/api/admin/reports/attendance/import`、`/api/admin/employees/import` 共用）。
 *
 * 設計取捨：
 * - 只支援逗號分隔、雙引號括住欄位（`""` 為逃脫的雙引號）的 RFC 4180 風格 CSV，
 *   這是 Excel「另存為 CSV」的預設輸出格式，也是規格要求要處理的格式。
 * - 一筆記錄可橫跨多個實體行（引號內的換行屬欄位內容，不切分記錄）。
 * - `rowNumber` 一律對應**原始檔的實際行號**，標題列固定為第 1 列。錯誤訊息會把
 *   這個數字回報給使用者，使用者要據此回 Excel 找到該行修正，因此不可用「第幾筆
 *   記錄」的邏輯序號代替：被略過的空白行、以及引號欄位內佔掉的換行，都必須計入，
 *   否則其後所有列號都會往前偏移。
 */

import { ApiError } from "./http";

export interface CsvLine {
  /** 於原始檔案中的邏輯列號；標題列固定為第 1 列。 */
  rowNumber: number;
  fields: string[];
}

/** 去除 UTF-8 BOM（Excel 匯出 CSV 一律會加）。 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 將 CSV 全文字串切成邏輯列與欄位陣列，尚未做標題名稱對應。
 * 處理 BOM、加引號欄位（含逗號、`""` 逃脫、欄位內換行）、CRLF 與 LF 換行、空白列略過。
 */
export function parseCsvLines(raw: string): CsvLine[] {
  const text = stripBom(raw);
  const lines: CsvLine[] = [];
  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let rowNumber = 1;
  let index = 0;
  const length = text.length;

  const pushField = (): void => {
    fields.push(field);
    field = "";
  };
  // 引號內已消耗的換行數。這些換行在原始檔中仍各佔一行，若不計入，
  // 只要檔案有任一欄位跨行，之後所有錯誤訊息回報的行號都會往前偏移，
  // 使用者照著到 Excel 裡找會找錯行。
  let quotedNewlines = 0;

  const pushLine = (): void => {
    pushField();
    const isBlank = fields.length === 1 && (fields[0] ?? "").trim() === "";
    if (!isBlank) lines.push({ rowNumber, fields });
    fields = [];
    rowNumber += 1 + quotedNewlines;
    quotedNewlines = 0;
  };

  while (index < length) {
    const ch = text.charAt(index);
    if (inQuotes) {
      if (ch === '"') {
        if (text.charAt(index + 1) === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      // 引號內的換行是欄位內容的一部分，但仍佔原始檔一行，需計入行號。
      // CRLF 視為一行，不可算成兩行。
      if (ch === "\r") {
        if (text.charAt(index + 1) === "\n") {
          field += "\r\n";
          index += 2;
        } else {
          field += "\r";
          index += 1;
        }
        quotedNewlines += 1;
        continue;
      }
      if (ch === "\n") {
        field += "\n";
        index += 1;
        quotedNewlines += 1;
        continue;
      }
      field += ch;
      index += 1;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (ch === ",") {
      pushField();
      index += 1;
      continue;
    }
    if (ch === "\r") {
      if (text.charAt(index + 1) === "\n") {
        pushLine();
        index += 2;
        continue;
      }
      pushLine();
      index += 1;
      continue;
    }
    if (ch === "\n") {
      pushLine();
      index += 1;
      continue;
    }
    field += ch;
    index += 1;
  }
  if (field !== "" || fields.length > 0) {
    pushLine();
  }
  return lines;
}

export interface CsvRow {
  /** 於原始檔案中的邏輯列號（標題列為第 1 列，因此第一筆資料列一律 >= 2）。 */
  rowNumber: number;
  /** 依標題名稱取值（去除前後空白）；該列沒有對應欄位時回傳空字串。 */
  get(name: string): string;
}

export interface CsvTable {
  header: string[];
  rows: CsvRow[];
}

/**
 * 解析帶標題列的 CSV，並依欄位名稱（而非位置）對應資料，允許標題順序不同。
 * 標題列缺少 requiredHeaders 任一欄位，或整份 CSV 完全沒有內容，視為整體性失敗（拋出 ApiError 400）。
 */
export function parseCsvTable(raw: string, requiredHeaders: readonly string[]): CsvTable {
  const lines = parseCsvLines(raw);
  const headerLine = lines[0];
  if (!headerLine) {
    throw new ApiError(400, "CSV 內容為空，找不到標題列。");
  }
  const header = headerLine.fields.map((cell) => cell.trim());
  const columnIndex = new Map<string, number>();
  header.forEach((name, position) => {
    if (!columnIndex.has(name)) columnIndex.set(name, position);
  });
  const missing = requiredHeaders.filter((name) => !columnIndex.has(name));
  if (missing.length > 0) {
    throw new ApiError(400, `CSV 標題列缺少必要欄位：${missing.join("、")}。`);
  }

  const rows: CsvRow[] = lines.slice(1).map((line) => ({
    rowNumber: line.rowNumber,
    get(name: string): string {
      const position = columnIndex.get(name);
      if (position === undefined) return "";
      return (line.fields[position] ?? "").trim();
    },
  }));
  return { header, rows };
}

/** 日期格式驗證，與既有 `src/server/m1.ts` 的 `isoDate` 採同一寬鬆規則（不逐月驗證天數上限）。 */
export function isValidIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/**
 * 解析非負數（可含小數，用於時數欄位）。空字串回傳 `emptyValue`；格式錯誤或為負數回傳 `null`。
 */
export function parseNonNegativeNumber(text: string, emptyValue: number | null = null): number | null {
  if (text === "") return emptyValue;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

/**
 * 解析非負整數（用於薪資欄位，僅接受純數字字串）。空字串回傳 `emptyValue`；格式錯誤回傳 `null`。
 */
export function parseNonNegativeInteger(text: string, emptyValue: number | null = null): number | null {
  if (text === "") return emptyValue;
  if (!/^\d+$/.test(text)) return null;
  return Number(text);
}
