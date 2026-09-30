import { h } from "preact";
import render from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { TestsPage } from "../src/client/pages/M2AdminPages";

describe("測驗管理 UI SSR", () => {
  it("呈現初始頁面、建立欄位與空選取提示", () => {
    const html = render(h(TestsPage, {}));
    expect(html).toContain("測驗紀錄");
    expect(html).toContain("新增場次測驗");
    expect(html).toContain("測驗名稱");
    expect(html).toContain("通過門檻");
    expect(html).toContain("請選擇測驗以登錄成績。");
  });
});
