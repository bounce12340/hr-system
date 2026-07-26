import { describe, expect, it } from "vitest";
import { buildCsv, buildXlsx } from "../src/client/export";

// 這支測試的重點不是「有沒有產生位元組」，而是產出的 .xlsx 是否為
// 結構正確的 ZIP。手寫二進位格式最典型的失敗是檔案看似產生成功、
// Excel 卻判定毀損，因此這裡實際把 ZIP 解析回來並逐項驗 CRC。

interface ParsedEntry {
  name: string;
  content: string;
  crcOk: boolean;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i]!;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 由中央目錄解析 ZIP，回傳每個項目的名稱、內容與 CRC 是否吻合。 */
function parseZip(bytes: Uint8Array): ParsedEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  // 由尾端往前找 end of central directory 標記。
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("找不到 ZIP 的 end of central directory");

  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const entries: ParsedEntry[] = [];

  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error("中央目錄標記不正確");
    const storedCrc = view.getUint32(cursor + 16, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));

    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("本地檔頭標記不正確");
    const localNameLength = view.getUint16(localOffset + 26, true);
    const extraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + extraLength;
    const data = bytes.subarray(dataStart, dataStart + size);

    entries.push({ name, content: decoder.decode(data), crcOk: crc32(data) === storedCrc });
    cursor += 46 + nameLength + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
  }

  return entries;
}

const FIXED_DATE = new Date(2026, 6, 26, 10, 30, 0);

describe("buildXlsx", () => {
  const rows = [
    ["部門", "在職人數", "薪資成本"],
    ["診所事業部", 6, 402000],
    ["醫院事業部", 5, 351000],
  ];

  it("產出可解析的 ZIP，且每個項目 CRC 正確", () => {
    const entries = parseZip(buildXlsx("人力結構", rows, FIXED_DATE));
    expect(entries.map((e) => e.name).sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/_rels/workbook.xml.rels",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    expect(entries.every((e) => e.crcOk)).toBe(true);
  });

  it("開頭是 ZIP 魔術位元組", () => {
    const bytes = buildXlsx("人力結構", rows, FIXED_DATE);
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it("字串以 inlineStr 寫入、數字以數值寫入", () => {
    const sheet = parseZip(buildXlsx("人力結構", rows, FIXED_DATE))
      .find((e) => e.name === "xl/worksheets/sheet1.xml")!.content;
    expect(sheet).toContain('<c r="A1" t="inlineStr"><is><t xml:space="preserve">部門</t></is></c>');
    expect(sheet).toContain('<c r="B2"><v>6</v></c>');
    expect(sheet).toContain('<c r="C3"><v>351000</v></c>');
  });

  it("工作表名稱寫入 workbook 並過濾非法字元", () => {
    const workbook = parseZip(buildXlsx("報表/統計[2026]", rows, FIXED_DATE))
      .find((e) => e.name === "xl/workbook.xml")!.content;
    expect(workbook).toContain('name="報表-統計-2026-"');
  });

  it("跳脫 XML 特殊字元，避免產生毀損檔案", () => {
    const sheet = parseZip(buildXlsx("s", [["A&B <測試>"]], FIXED_DATE))
      .find((e) => e.name === "xl/worksheets/sheet1.xml")!.content;
    expect(sheet).toContain("A&amp;B &lt;測試&gt;");
  });

  it("超過 26 欄時欄位代號正確進位", () => {
    const wide = [Array.from({ length: 28 }, (_, i) => i)];
    const sheet = parseZip(buildXlsx("s", wide, FIXED_DATE))
      .find((e) => e.name === "xl/worksheets/sheet1.xml")!.content;
    expect(sheet).toContain('<c r="Z1">');
    expect(sheet).toContain('<c r="AA1">');
    expect(sheet).toContain('<c r="AB1">');
  });

  // XML 1.0 不接受多數控制字元，帶進去會讓 Excel 判定檔案毀損。
  // 這類 bug 不會讓程式報錯，只會讓使用者點下載後打不開，因此明確鎖住。
  it("濾除 XML 不合法的控制字元", () => {
    const dirty = `正常${String.fromCharCode(0)}文${String.fromCharCode(11)}字${String.fromCharCode(31)}`;
    const bytes = buildXlsx("s", [[dirty]], FIXED_DATE);
    const sheet = parseZip(bytes).find((e) => e.name === "xl/worksheets/sheet1.xml")!.content;
    expect(sheet).toContain("正常文字");
    expect(/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(sheet)).toBe(false);
  });

  it("保留合法的空白字元（tab 與換行）", () => {
    const sheet = parseZip(buildXlsx("s", [["第一行\n第二行\t欄"]], FIXED_DATE))
      .find((e) => e.name === "xl/worksheets/sheet1.xml")!.content;
    expect(sheet).toContain("第一行\n第二行\t欄");
  });

  it("空值產生空儲存格而非 undefined 字串", () => {
    const sheet = parseZip(buildXlsx("s", [["有值", null, undefined, ""]], FIXED_DATE))
      .find((e) => e.name === "xl/worksheets/sheet1.xml")!.content;
    expect(sheet).not.toContain("undefined");
    expect(sheet).not.toContain("null");
  });
});

describe("buildCsv", () => {
  it("含 UTF-8 BOM，避免 Excel 開啟中文亂碼", () => {
    expect(buildCsv([["部門"]]).charCodeAt(0)).toBe(0xfeff);
  });

  it("含逗號、引號或換行的值會被正確引用", () => {
    const csv = buildCsv([["a,b", 'say "hi"', "line1\nline2", "plain"]]);
    expect(csv).toContain('"a,b"');
    expect(csv).toContain('"say ""hi"""');
    expect(csv).toContain('"line1\nline2"');
    expect(csv).toContain(",plain");
  });

  it("以 CRLF 分隔資料列", () => {
    expect(buildCsv([["a"], ["b"]])).toBe("﻿a\r\nb");
  });
});
