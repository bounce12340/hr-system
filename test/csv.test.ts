import { describe, expect, it } from "vitest";
import {
  isValidIsoDate,
  parseCsvLines,
  parseCsvTable,
  parseNonNegativeInteger,
  parseNonNegativeNumber,
} from "../src/server/csv";
import { ApiError } from "../src/server/http";

describe("parseCsvLines", () => {
  it("去除 UTF-8 BOM", () => {
    const lines = parseCsvLines("﻿a,b\n1,2\n");
    expect(lines).toEqual([
      { rowNumber: 1, fields: ["a", "b"] },
      { rowNumber: 2, fields: ["1", "2"] },
    ]);
  });

  it("處理加引號欄位內的逗號", () => {
    const lines = parseCsvLines('a,b\n"1,000",2\n');
    expect(lines[1]).toEqual({ rowNumber: 2, fields: ["1,000", "2"] });
  });

  it("處理欄位內逃脫的雙引號 \"\"", () => {
    const lines = parseCsvLines('a,b\n"He said ""hi""",2\n');
    expect(lines[1]).toEqual({ rowNumber: 2, fields: ['He said "hi"', "2"] });
  });

  it("同時支援 CRLF 與 LF 換行", () => {
    const lines = parseCsvLines("a,b\r\n1,2\n3,4\r\n");
    expect(lines).toEqual([
      { rowNumber: 1, fields: ["a", "b"] },
      { rowNumber: 2, fields: ["1", "2"] },
      { rowNumber: 3, fields: ["3", "4"] },
    ]);
  });

  it("引號內的換行視為欄位內容，不視為換行", () => {
    const lines = parseCsvLines('a,b\n"line1\nline2",2\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual({ rowNumber: 2, fields: ["line1\nline2", "2"] });
  });

  // 錯誤訊息會回報列號讓使用者回 Excel 修檔，因此列號必須對得上原始檔的
  // 實際行號。引號內的換行雖屬欄位內容，仍佔原始檔一行，漏算會使該筆之後
  // 所有列號往前偏移。
  it("跨行欄位之後的列號仍對應原始檔實際行號", () => {
    // 實際行號：1=標題、2-3=跨行記錄、4=最後一筆
    const lines = parseCsvLines('a,b\n"x\ny",2\n3,4\n');
    expect(lines.map((line) => line.rowNumber)).toEqual([1, 2, 4]);
  });

  it("跨行欄位中的 CRLF 只算一行", () => {
    const lines = parseCsvLines('a,b\r\n"x\r\ny",2\r\n3,4\r\n');
    expect(lines.map((line) => line.rowNumber)).toEqual([1, 2, 4]);
    expect(lines[1]?.fields[0]).toBe("x\r\ny");
  });

  it("空白列同樣計入實際行號", () => {
    // 實際行號：1=標題、2=空、3=資料、4-5=空、6=資料
    const lines = parseCsvLines("a,b\n\n1,2\n\n\n3,4\n");
    expect(lines.map((line) => line.rowNumber)).toEqual([1, 3, 6]);
  });

  it("引號內的 CRLF 也視為欄位內容", () => {
    const lines = parseCsvLines('a,b\n"line1\r\nline2",2\n');
    expect(lines[1]?.fields[0]).toBe("line1\r\nline2");
  });

  it("略過完全空白的列，但後續列的行號仍反映實際檔案位置", () => {
    const lines = parseCsvLines("a,b\n1,2\n\n3,4\n");
    expect(lines).toEqual([
      { rowNumber: 1, fields: ["a", "b"] },
      { rowNumber: 2, fields: ["1", "2"] },
      { rowNumber: 4, fields: ["3", "4"] },
    ]);
  });

  it("沒有結尾換行符的最後一列仍會被解析", () => {
    const lines = parseCsvLines("a,b\n1,2");
    expect(lines).toEqual([
      { rowNumber: 1, fields: ["a", "b"] },
      { rowNumber: 2, fields: ["1", "2"] },
    ]);
  });

  it("空字串回傳空陣列", () => {
    expect(parseCsvLines("")).toEqual([]);
  });
});

describe("parseCsvTable", () => {
  const headers = ["員工編號", "日期", "缺勤時數"] as const;

  it("依標題名稱對應欄位，允許欄位順序不同", () => {
    const table = parseCsvTable("日期,缺勤時數,員工編號\n2026-01-01,3,E001\n", headers);
    expect(table.rows).toHaveLength(1);
    const row = table.rows[0];
    expect(row?.get("員工編號")).toBe("E001");
    expect(row?.get("日期")).toBe("2026-01-01");
    expect(row?.get("缺勤時數")).toBe("3");
    expect(row?.rowNumber).toBe(2);
  });

  it("缺少必要標題時拋出 ApiError 400", () => {
    expect(() => parseCsvTable("員工編號,日期\nE001,2026-01-01\n", headers)).toThrow(ApiError);
    try {
      parseCsvTable("員工編號,日期\nE001,2026-01-01\n", headers);
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(400);
      expect((error as ApiError).message).toContain("缺勤時數");
    }
  });

  it("完全沒有內容時拋出 ApiError 400", () => {
    expect(() => parseCsvTable("", headers)).toThrow(ApiError);
    expect(() => parseCsvTable("\n\n", headers)).toThrow(ApiError);
  });

  it("資料列缺少的尾端欄位回傳空字串", () => {
    const table = parseCsvTable("員工編號,日期,缺勤時數\nE001,2026-01-01\n", headers);
    expect(table.rows[0]?.get("缺勤時數")).toBe("");
  });

  it("取值時去除欄位前後空白", () => {
    const table = parseCsvTable("員工編號,日期,缺勤時數\n  E001 , 2026-01-01 , 3 \n", headers);
    expect(table.rows[0]?.get("員工編號")).toBe("E001");
    expect(table.rows[0]?.get("缺勤時數")).toBe("3");
  });
});

describe("isValidIsoDate", () => {
  it("接受合法的 YYYY-MM-DD", () => {
    expect(isValidIsoDate("2026-07-25")).toBe(true);
  });
  it("拒絕格式錯誤的日期", () => {
    expect(isValidIsoDate("2026/07/25")).toBe(false);
    expect(isValidIsoDate("not-a-date")).toBe(false);
    expect(isValidIsoDate("")).toBe(false);
  });
});

describe("parseNonNegativeNumber", () => {
  it("空字串回傳 emptyValue", () => {
    expect(parseNonNegativeNumber("", 0)).toBe(0);
    expect(parseNonNegativeNumber("", null)).toBeNull();
  });
  it("接受非負數（含小數）", () => {
    expect(parseNonNegativeNumber("3.5")).toBe(3.5);
    expect(parseNonNegativeNumber("0")).toBe(0);
  });
  it("拒絕負數與非數字", () => {
    expect(parseNonNegativeNumber("-1")).toBeNull();
    expect(parseNonNegativeNumber("abc")).toBeNull();
  });
});

describe("parseNonNegativeInteger", () => {
  it("空字串回傳 emptyValue", () => {
    expect(parseNonNegativeInteger("", null)).toBeNull();
  });
  it("接受非負整數", () => {
    expect(parseNonNegativeInteger("50000")).toBe(50000);
    expect(parseNonNegativeInteger("0")).toBe(0);
  });
  it("拒絕小數、負數與非數字", () => {
    expect(parseNonNegativeInteger("3.5")).toBeNull();
    expect(parseNonNegativeInteger("-1")).toBeNull();
    expect(parseNonNegativeInteger("abc")).toBeNull();
  });
});
