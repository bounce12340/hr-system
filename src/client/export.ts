// 報表匯出：CSV 與 XLSX，皆於前端產生，零第三方相依。
//
// 設計決定（規格 §二 原指定 SheetJS）：
// npm 上的 xlsx 停在 0.18.5（2022-03），官方改由自架 CDN 發佈，而以 URL 形式
// 安裝的相依套件無法被 npm audit／Dependabot 追蹤，等於放棄自動更新與漏洞通知。
// 報表匯出只需要「二維表格 → 檔案」，因此改為自行產生：零相依、零漏洞面、
// 不需要持續更新，bundle 幾乎不增加。
//
// 實作要點：.xlsx 是一個裝著 OOXML 的 ZIP。此處 ZIP 一律採 STORED（不壓縮），
// 因此不需要任何壓縮演算法，只需 CRC32 與標頭組裝；Excel、LibreOffice 與
// Google Sheets 都能正常開啟未壓縮的 .xlsx。

export type CellValue = string | number | boolean | null | undefined;
export type SheetRow = readonly CellValue[];

// --- CRC32（ZIP 標頭必需） -------------------------------------------------

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    // 迴圈上界即為陣列長度，索引必定在範圍內；專案啟用 noUncheckedIndexedAccess，故明示。
    crc = table[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// --- ZIP（STORED，不壓縮） -------------------------------------------------

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

// MS-DOS 時間格式：時間 2 秒精度，日期自 1980 年起算。
function dosDateTime(date: Date): { time: number; date: number } {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f);
  const day =
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

function buildZip(entries: readonly ZipEntry[], modifiedAt: Date): Uint8Array {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(modifiedAt);

  const prepared = entries.map((entry) => {
    const nameBytes = encoder.encode(entry.name);
    return { nameBytes, data: entry.data, crc: crc32(entry.data), offset: 0 };
  });

  const localSize = prepared.reduce((sum, e) => sum + 30 + e.nameBytes.length + e.data.length, 0);
  const centralSize = prepared.reduce((sum, e) => sum + 46 + e.nameBytes.length, 0);
  const output = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(output.buffer);
  let cursor = 0;

  for (const entry of prepared) {
    entry.offset = cursor;
    view.setUint32(cursor, 0x04034b50, true);
    view.setUint16(cursor + 4, 20, true); // 解壓所需版本
    view.setUint16(cursor + 6, 0x0800, true); // 檔名為 UTF-8
    view.setUint16(cursor + 8, 0, true); // 壓縮方式：0 = stored
    view.setUint16(cursor + 10, time, true);
    view.setUint16(cursor + 12, date, true);
    view.setUint32(cursor + 14, entry.crc, true);
    view.setUint32(cursor + 18, entry.data.length, true); // 未壓縮，兩個長度相同
    view.setUint32(cursor + 22, entry.data.length, true);
    view.setUint16(cursor + 26, entry.nameBytes.length, true);
    view.setUint16(cursor + 28, 0, true); // extra field 長度
    cursor += 30;
    output.set(entry.nameBytes, cursor);
    cursor += entry.nameBytes.length;
    output.set(entry.data, cursor);
    cursor += entry.data.length;
  }

  const centralStart = cursor;
  for (const entry of prepared) {
    view.setUint32(cursor, 0x02014b50, true);
    view.setUint16(cursor + 4, 20, true); // 建立版本
    view.setUint16(cursor + 6, 20, true); // 解壓所需版本
    view.setUint16(cursor + 8, 0x0800, true);
    view.setUint16(cursor + 10, 0, true);
    view.setUint16(cursor + 12, time, true);
    view.setUint16(cursor + 14, date, true);
    view.setUint32(cursor + 16, entry.crc, true);
    view.setUint32(cursor + 20, entry.data.length, true);
    view.setUint32(cursor + 24, entry.data.length, true);
    view.setUint16(cursor + 28, entry.nameBytes.length, true);
    view.setUint16(cursor + 30, 0, true); // extra
    view.setUint16(cursor + 32, 0, true); // comment
    view.setUint16(cursor + 34, 0, true); // 磁碟編號
    view.setUint16(cursor + 36, 0, true); // 內部屬性
    view.setUint32(cursor + 38, 0, true); // 外部屬性
    view.setUint32(cursor + 42, entry.offset, true);
    cursor += 46;
    output.set(entry.nameBytes, cursor);
    cursor += entry.nameBytes.length;
  }

  view.setUint32(cursor, 0x06054b50, true);
  view.setUint16(cursor + 4, 0, true);
  view.setUint16(cursor + 6, 0, true);
  view.setUint16(cursor + 8, prepared.length, true);
  view.setUint16(cursor + 10, prepared.length, true);
  view.setUint32(cursor + 12, cursor - centralStart, true);
  view.setUint32(cursor + 16, centralStart, true);
  view.setUint16(cursor + 20, 0, true); // 註解長度

  return output;
}

// --- XLSX ------------------------------------------------------------------

// XML 1.0 不允許多數控制字元，未過濾會導致 Excel 判定檔案毀損。
const INVALID_XML_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

function escapeXml(value: string): string {
  return value
    .replace(INVALID_XML_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// 0 → A、25 → Z、26 → AA
function columnRef(index: number): string {
  let ref = "";
  let remaining = index;
  while (remaining >= 0) {
    ref = String.fromCharCode(65 + (remaining % 26)) + ref;
    remaining = Math.floor(remaining / 26) - 1;
  }
  return ref;
}

// Excel 工作表名稱限制：不得含 \ / ? * [ ] :，長度上限 31。
function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, "-").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 31) : "工作表1";
}

function cellXml(value: CellValue, ref: string): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  const text = typeof value === "boolean" ? (value ? "是" : "否") : String(value);
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

function sheetXml(rows: readonly SheetRow[]): string {
  const body = rows
    .map((row, rowIndex) => {
      const cells = row.map((value, colIndex) => cellXml(value, `${columnRef(colIndex)}${rowIndex + 1}`)).join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

/**
 * 產生 .xlsx 位元組內容。rows 第一列通常是標題列。
 * modifiedAt 可指定以取得可重現的輸出（測試用）。
 */
export function buildXlsx(sheetName: string, rows: readonly SheetRow[], modifiedAt = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const safeName = sanitizeSheetName(sheetName);

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(safeName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;

  return buildZip(
    [
      { name: "[Content_Types].xml", data: encoder.encode(contentTypes) },
      { name: "_rels/.rels", data: encoder.encode(rootRels) },
      { name: "xl/workbook.xml", data: encoder.encode(workbook) },
      { name: "xl/_rels/workbook.xml.rels", data: encoder.encode(workbookRels) },
      { name: "xl/worksheets/sheet1.xml", data: encoder.encode(sheetXml(rows)) },
    ],
    modifiedAt,
  );
}

// --- CSV -------------------------------------------------------------------

function csvCell(value: CellValue): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "boolean" ? (value ? "是" : "否") : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * 產生 CSV 內容。開頭加上 UTF-8 BOM，否則 Excel 開啟時中文會變亂碼。
 */
export function buildCsv(rows: readonly SheetRow[]): string {
  const body = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  return `﻿${body}`;
}

// --- 下載 ------------------------------------------------------------------

function triggerDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function exportCsv(filename: string, rows: readonly SheetRow[]): void {
  triggerDownload(filename, new Blob([buildCsv(rows)], { type: "text/csv;charset=utf-8" }));
}

export function exportXlsx(filename: string, sheetName: string, rows: readonly SheetRow[]): void {
  const bytes = buildXlsx(sheetName, rows);
  const blob = new Blob([bytes as unknown as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  triggerDownload(filename, blob);
}
