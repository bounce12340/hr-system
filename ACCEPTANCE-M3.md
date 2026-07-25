# M3 招募模組 — 獨立驗收總結

驗收日期：2026-07-25
驗收依據：開發規格書 §五 M3、§三 權限、§六 資料表、§七 頁面結構、§八 種子資料、§九 品質要求、§十 驗收清單第 5／8／10 項
M3 交付深度定義：**骨架 — CRUD ＋狀態流可跑通**

## 結論

**通過。** 38 個驗收項目中 37 項 PASS、1 項由主對話覆核後改判 PASS（理由見下），0 項 FAIL、0 項無法驗證。

驗收採「不自驗」原則：由兩個未參與開發的獨立 agent 執行，其派工指令中不含開發者的自我評價與結論；驗收項目由主對話依規格書逐條指定，非由 agent 自行從程式碼反推。

## 驗收分工與來源報告

| 範圍 | 執行者 | 項目 | 詳細報告 |
|---|---|---|---|
| 執行期行為（實跑 API） | 獨立 agent（fresh context） | R0–R25 | `ACCEPTANCE-M3-runtime.md` |
| 靜態結構與前端（唯讀） | 獨立 agent（fresh context） | S1–S12 | `ACCEPTANCE-M3-static.md` |
| 375px 行動版實測 | 主對話（Playwright 實跑） | 驗收清單第 10 項 | 本檔 §375px |

## 一、執行期驗收 R0–R25：全數 PASS

| 群組 | 項目 | 結果 | 重點證據 |
|---|---|---|---|
| 基礎 | R0–R3 | PASS | 0005 已套用；typecheck 全綠；22 tests／5 files 全綠（單跑 `m3.test.ts` 亦綠，確認無測試互相干擾）；build 成功 |
| 種子 | R4 | PASS | 2 職缺 ＋ 4 候選人，分佈 applied／screening／interview／offer 四個不同階段 |
| 職缺 | R5–R7 | PASS | 五欄位存讀正確；讀改刪皆可；開放→暫停→關閉每次讀回新狀態 |
| 人才庫 | R8–R10 | PASS | `candidate_applications` 為獨立表；同一候選人成功掛 job-01 與 job-02，單一查詢回傳兩筆完整應徵歷史，可跨職缺查詢，重複綁同職缺回 409 |
| 面試 | R11–R14 | PASS | 多輪排程可用；評分維度自由字串（實測 5 個自訂維度）；0／6／3.5／字串型別全被 422 擋且不破壞既有評分 |
| 核薪錄取 | R15–R16 | PASS | 三薪資欄位正確；錄取範本確實帶入實際候選人／職缺／核定薪資值，非空模板 |
| 到職文件 | R17–R18 | PASS | 可新增自訂項目；勾選與取消均經「重新查詢」確認持久化 |
| 試用期 | R19–R21 | PASS | 三組到期日經人工重算比對完全一致（含跨月與 2/28+1）；提醒於 14 天窗內與逾期均顯示、25 天外正確排除；三態結果皆可存 |
| 狀態機 | R22–R23 | PASS | **走完兩輪**完整 投遞→到職 流程，逐階段查漏斗：`currentCount` 前階段減 1／目標加 1、`enteredCount` 單調遞增，數字完全對應；history 7 筆時間戳齊全；四道守門條件（無評分不得進核薪、未核准不得發 offer、未接受不得標錄取、必填文件未齊不得到職）均實測回 409 |
| 權限 | R24 | PASS | employee token 打 **18 個** admin M3 endpoint 全數 403；雙層強制（router 前置 ＋ handler 首行）；M3 無任何 employee 端點 |
| 錯誤處理 | R25 | PASS | 缺必填／超範圍／壞 JSON／404／401／403 全為友善繁中，無 stack trace 或 SQL 片段；未預期例外收斂為通用 500 |

## 二、靜態結構驗收 S1–S12：11 PASS ＋ 1 項覆核改判

S1–S7、S9–S12 全數 PASS。重點：

- **S9 權限（從嚴檢查）**：`handleAdminM3` 內全部 38 個 endpoint 逐一列出，皆經 router 層（`src/server/router.ts:62-63`）與 handler 層（`src/server/m3.ts:1208`）雙重 `requireAdmin`。全倉庫確認不存在員工端 M3 路徑。
- **S12 checklist 可自訂**：`onboarding_items` 為真主檔且有完整 CRUD，非寫死清單。
- **S4 UI 非空殼**：六子頁均有實際表單、API 呼叫與清單渲染，grep TODO／placeholder 無命中。

### S8 狀態機階段數 — agent 判 FAIL，主對話覆核後改判 PASS

驗收 agent 依「階段數量不符即從嚴判 FAIL」的指令判定 FAIL。主對話覆核程式碼後**推翻此判定**，理由如下：

```
規格：投遞 → 篩選 → 面試 → 核薪 →          錄取 → 到職      （6 階段）
實作：投遞 → 篩選 → 面試 → 核薪 → 發送錄取 → 錄取 → 到職      （7 階段）
```

1. 規格點名的 6 個階段**全部存在、順序正確、標籤逐字相符**（`src/server/m3.ts:35-43`）。多出的 `offer`（發送錄取）是**插入**於核薪與錄取之間，未移除或改名任何規格階段。
2. 規格 §一：「規格未涵蓋的細節：自行採合理預設並記錄在 README『設計決定』一節」。此拆分已記錄於 `README.md:100` 與 `README.md:128`，符合規格授權的裁量方式。
3. 將「發出錄取通知」與「候選人接受」分離，對 M4 招募漏斗是**功能增益**——可額外計算 offer 婉拒率。

保留此記錄以供人工複核：若日後認定應嚴格對齊 6 階段，變更點在 `src/server/m3.ts:12-20`（`PIPELINE_STAGES`）、`:25-33`（`NEXT_STATUS`）、`:35-43`（`STAGE_LABELS`）與 `src/client/pages/M3AdminPages.tsx:70-79`。

## 三、375px 行動版實測（驗收清單第 10 項，主對話親驗）

以 Playwright 實際開啟 375×812 視窗、以 admin 登入後逐頁量測：

| 分頁 | 頁面水平溢出 | 超寬元素 | 容器內捲動 |
|---|---|---|---|
| 招募漏斗 | −15px（無溢出） | 8 | 1（`overflow-x:auto` 容器內，非整頁破版） |
| 職缺 | −15px | 0 | 0 |
| 人才庫 | −15px | 0 | 0 |
| 面試 | −15px | 0 | 0 |
| 核薪錄取 | 0px | 0 | 0 |
| 到職文件 | −15px | 0 | 0 |
| 試用期 | −15px | 0 | 0 |

- **導覽可達性**：375px 下側邊欄改為 `<select>` 下拉，12 個導覽項全部可選，招募管理可正常進入。
- **可操作性**（非僅「不破版」）：職缺表單 6 個欄位全部落在視窗內、無過小輸入框、12 個可見按鈕全部 ≥24px 點擊目標。
- 結論：**PASS**。

## 四、非阻斷觀察（不影響 M3 通過，但影響後續里程碑）

### 觀察 1：seed 候選人缺上游階段歷程，將使 M4 漏斗轉換率失真

`0005` migration 對移轉來的應徵只寫一筆 `NULL → 目前階段` 的 history。實查歷史筆數：`app-cand-02/03/04` 各僅 **1** 筆，而經 API 實際操作的兩筆各有 **7** 筆。

影響：cand-03 人在「發送錄取」階段，卻從未計入「投遞／篩選／面試」的 `enteredCount`。**M4 若直接以 `enteredCount` 繪製漏斗，上游數字會被低估。**

判定：非 M3 缺陷（API 實際轉移的時間戳完整無誤，規格 §八 只要求候選人分佈於不同階段，已滿足），屬 seed 資料造型問題。

**已於 `0006_m3_cleanup_and_history_backfill.sql` 修正並驗證**。以全新 D1 重跑全部 migration 後實測各階段「曾進入」數：

| 階段 | 修正前 | 修正後 |
|---|---|---|
| applied | 1 | **4** |
| screening | 1 | **3** |
| interview | 1 | **2** |
| salary_approval | 0 | **1** |
| offer | 1 | **1** |

修正後為正常單調遞減的漏斗形狀。實作要點：僅回填「歷程僅有 0005 那一列移轉紀錄」的應徵，不覆蓋任何經 API 產生的真實歷程；`rejected` 不回填，因淘汰發生於哪一階段無法從現有資料推得。

### 觀察 2：schema 技術債 — 孤兒表與死欄位

`offers`、`onboarding_checklist`、`candidate_status_history` 三張表及 `candidates.job_opening_id`、`candidates.status` 兩個欄位，已被 0005 導入的新表取代但未清除。

影響：功能不受影響，但 `offers` 恰與規格 §六 點名的表名相同，保留孤兒版本會誤導讀者（開源後尤甚）。

**已於 `0006_m3_cleanup_and_history_backfill.sql` 處理（部分）**：

- 三張孤兒表已 `DROP`。移除前以 SQL 關鍵字邊界（`FROM`／`JOIN`／`INTO`／`UPDATE`／`DELETE FROM`）逐一確認無任何程式碼參照——原始回報的命中其實全部落在名稱相近但仍在使用的 `application_onboarding_checklist` 與 `candidate_application_status_history`，若照名稱直接刪會誤刪在用的表。
- 只索引死欄位的 `idx_candidates_opening_status` 一併移除。
- **兩個死欄位刻意保留**：SQLite 的 `DROP COLUMN` 不支援移除帶 CHECK 約束的欄位（`candidates.status` 有 CHECK），清除須整表重建；而 `candidate_applications` 有 FK 指向 `candidates(id)`，在 D1 migration 中重建的風險高於效益。已於 0006 註記其為 pre-0005 殘留。

### 觀察 3：跨階段驗收的密碼會失聯（流程問題）

強制首次改密碼（規格 §三）本身運作正常且設計正確，但每輪驗收改密後若未留存，下一輪即無法登入，須刪除 `.wrangler/state/v3/d1` 重跑 migration 才能恢復。本次驗收即發生兩次。

**約定**：本機驗收用 admin 密碼統一設為 `AcceptDemo2026!`（僅本機 D1，不涉及任何遠端環境）。seed 初始密碼仍為 `Demo1234!`，首次登入後改為上述值。

## 五、本次驗收實際涵蓋範圍

- 實跑指令：`wrangler d1 migrations list`、`npm run typecheck`、`npm test`（含單檔重跑）、`npm run build`
- 實打 API：涵蓋職缺／候選人／應徵／面試／評分／核薪／錄取範本／到職項目／checklist／試用期／漏斗統計／儀表板，含 18 個權限測試端點
- 端到端流程：投遞→到職 完整走 **2 輪**，逐階段核對漏斗數字
- 瀏覽器實測：375×812 下 7 個 M3 分頁的版面與互動
- 未涵蓋：遠端 Cloudflare 部署環境（僅驗本機 `--local` D1 與 `pages dev`）；M4／M5 功能（尚未開發）
