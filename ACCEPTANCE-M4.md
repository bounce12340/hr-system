# M4 報表與儀表板 — 獨立驗收報告

驗收日期：2026-07-27
驗收者：獨立驗收 agent（未參與 M4 實作）
驗收目標：`D:\hr-system` M4 報表模組是否滿足規格書 `C:\Users\BDAIPC\hr-system-prompt.md` §五 M4 與相關跨模組要求。

## 驗收環境（與使用者環境完全隔離）

- 獨立資料庫：`.wrangler/state-verify-m4`（**未觸碰** `.wrangler/state` 與 `.wrangler/state-manual`）
- 獨立 port：`http://127.0.0.1:8791`（`npx wrangler pages dev dist --port 8791 --persist-to .wrangler/state-verify-m4`）
- 帳號：admin `admin@demo.local` / `AcceptDemo2026!`；employee `chiahao.lin@demo.local` / `AcceptDemo2026!`（皆走過首次登入強制改密碼流程）
- 瀏覽器驗證：Playwright（Chromium），桌機 1280×900 與手機 375×812 兩種寬度
- XLSX 獨立驗證：`C:\Users\BDAIPC\AppData\Local\Programs\Python\Python311\python.exe`，`zipfile` + `xml.etree.ElementTree`（另以 `openpyxl 3.1.5` 交叉驗證）

---

## 結論總表

| 項目 | 結果 | 一句話 |
|---|---|---|
| R1 typecheck（4 projects） | **PASS** | exit 0 |
| R2 npm test | **PASS** | 14 檔 / 132 測試全過 |
| R3 npm run build | **PASS** | vite build 成功 |
| R4 全新 DB 套用 0001–0008 | **PASS** | 8 支 migration 全部 ✅ |
| R5 在職人數／人力結構（部門＋職等） | **PASS** | 兩種分佈都有，SQL 對帳一致 |
| R6 離職率公式 | **PASS（計算）／FAIL（README 記錄）** | 算式正確，但 README 完全沒寫，且內容過時錯誤 |
| R7 缺勤加班資料來源 | **PASS** | 確為 `attendance` 表，未誤接 `enrollments.attendance_status` |
| R8 招募漏斗 | **PASS** | 與 SQL 逐階段一致（seed 資料有時間戳問題，見下） |
| R9 教育訓練完成率（全公司／部門） | **PASS** | 兩種都能算（fresh DB 種子無完訓紀錄，見下） |
| R10 薪資成本 | **PASS** | 646,000 / 12 人，SQL 對帳一致 |
| R11 通用篩選逐張確認 | **PASS（含 3 個已記錄的合理例外）** | 見下方逐張表 |
| R12 實際點擊匯出 CSV／XLSX | **PASS** | 部門＋期間篩選後實際取得檔案 |
| R13 XLSX 獨立工具驗證 | **PASS** | ZIP／CRC／組件／中文／數字全部正確 |
| R14 出缺勤手動 CRUD | **PASS** | API 與 UI 兩路徑都通 |
| R15 出缺勤 CSV 匯入錯誤行號 | **PASS** | 含引號內換行後行號仍正確 |
| R16 員工主檔 CSV 匯入 | **PASS** | 同樣逐列回報且行號正確 |
| R17 employee token 打 M4 admin 端點 | **PASS** | 12 個端點全 403 |
| R18 薪資 admin-only | **PASS** | 員工端 8 個端點皆無薪資欄位 |
| R19 錯誤處理 | **PASS（2 個小瑕疵）** | 全繁中、無 stack trace |
| R20 375px 手機寬度 | **PASS** | 無頁面級水平溢出，主要操作可觸及 |

**總計：18 PASS、1 PASS/FAIL 混合（R6）、1 PASS 附小瑕疵（R19）。**
**唯一需要修的是 R6 的 README 文件缺口（Medium）；其餘為 Low/Nit。**

---

## 逐條驗收明細

### R1 — `npm run typecheck` 全綠（四個 tsconfig project）

**PASS.** `package.json` 的 typecheck 腳本以 `&&` 串接四個 project：
`tsconfig.client.json`、`tsconfig.worker.json`、`tsconfig.test.json`、`tsconfig.tools.json`。
實跑結果 exit code 0，無任何輸出。四個都過（`&&` 串接，任一失敗即中斷並非零退出）。

### R2 — `npm test` 全綠

**PASS.** `vitest run`：**Test Files 14 passed (14)、Tests 132 passed (132)**，0 failed / 0 skipped，耗時 5.66s。

### R3 — `npm run build`

**PASS.** `vite build` 成功，30 modules transformed，產出
`dist/assets/index-CTSFyKT4.js` 335.13 kB（gzip 97.79 kB）、`dist/assets/index-_wCBd-Oq.css` 27.31 kB。

### R4 — 全新資料庫套用 0001–0008

**PASS.** 對空的 `.wrangler/state-verify-m4` 執行
`npx wrangler d1 migrations apply DB --local --persist-to .wrangler/state-verify-m4`，
0001～0008 全部 ✅，無錯誤、無需人工修補。

### R5 — 在職人數與人力結構（部門與職等兩種分佈）

**PASS.** 端點 `GET /api/admin/reports/headcount`。兩種分佈都存在：回應同時含 `byDepartment` 與 `byGrade`（`src/server/m4.ts:194-195`），前端也各畫一張長條圖（`src/client/pages/M4AdminPages.tsx:260-279`，「部門人力分佈」「職等人力分佈」）。

自行以 SQL 對照（`startMonth=2026-01&endMonth=2026-06`，asOf = 2026-06-30）：

```sql
SELECT department, grade, COUNT(*) FROM employees
WHERE hire_date <= '2026-06-30'
  AND (termination_date IS NULL OR termination_date > '2026-06-30')
GROUP BY department, grade;
```

| 維度 | SQL | API | 一致 |
|---|---|---|---|
| 人資行政部 | 2+1+1 = 4 | 4 | ✅ |
| 診所事業部 | 1+1+1+1 = 4 | 4 | ✅ |
| 醫院事業部 | 1+2+1 = 4 | 4 | ✅ |
| G2 / G3 / G4 / G5 / G6 | 2 / 3 / 4 / 2 / 1 | 2 / 3 / 4 / 2 / 1 | ✅ |
| 合計 | 12 | 12 | ✅ |

### R6 — 離職率公式 ⚠️ 計算 PASS，README 記錄 FAIL

**實作採用的定義**（`src/server/m4.ts:199-228`）：

```
離職率 = 期間內離職數 ÷ 平均在職數 × 100%
平均在職數 = (期初在職數 + 期末在職數) ÷ 2
期初在職數 = 起月 1 日仍在職的人數
期末在職數 = 迄月最後一日仍在職的人數
期間內離職數 = termination_date ∈ [起月-01, 迄月次月-01)
```

**我的重算（`startMonth=2026-01&endMonth=2026-06`）：**

以 SQL 獨立取三個輸入值：

```sql
SELECT
 (SELECT COUNT(*) FROM employees WHERE termination_date IS NOT NULL
    AND termination_date >= '2026-01-01' AND termination_date < '2026-07-01') AS term_in_period, -- 3
 (SELECT COUNT(*) FROM employees WHERE hire_date <= '2026-01-01'
    AND (termination_date IS NULL OR termination_date > '2026-01-01')) AS hc_start,             -- 15
 (SELECT COUNT(*) FROM employees WHERE hire_date <= '2026-06-30'
    AND (termination_date IS NULL OR termination_date > '2026-06-30')) AS hc_end;               -- 12
```

- 我的算式：平均在職 = (15 + 12) / 2 = **13.5**；離職率 = 3 / 13.5 × 100 = **22.2222…% → 22.22%**
- 系統值：`{"terminations":3,"startHeadcount":15,"endHeadcount":12,"averageHeadcount":13.5,"turnoverRate":22.22}`
- **完全一致 ✅**（另以 `grade=G4` 再驗一次：1 ÷ ((5+4)/2) = 22.22%，系統同值）

**❌ FAIL 的部分：規格要求「確認實作採用哪個定義且有記錄在 README」——README 沒有記錄。**

- `README.md` 全文搜尋 `平均在職` / `averageHeadcount` / `離職率` / `turnover`：**零命中**。
- 更嚴重的是 README 對 M4 的敘述是**錯的**：
  - `README.md:5`：「M4～M5 仍只有既有 schema，**尚未建立應用路由或頁面**」
  - `README.md:155-157`：「## 尚未開始 — M4 報表與 M5 人才盤點的功能、路由與頁面**尚未開始**」
  - 但 M4 六項指標 API（`src/server/m4.ts`）、報表頁（`src/client/pages/M4AdminPages.tsx`）、側邊欄入口都已實作並可運作。

定義目前只記錄在兩處非 README 的位置：程式註解 `src/server/m4.ts:199`，以及 UI 卡片說明文字「平均在職數＝期初期末平均」（`M4AdminPages.tsx:304`）。

**建議修正**：更新 README 的完成度敘述，並在 M4 章節寫明離職率／平均在職數定義，以及下方 R11 的三個篩選例外。

### R7 — 缺勤與加班統計的資料來源

**PASS，且已明確排除誤接風險。**

- `src/server/m4.ts:242` 的 FROM 子句為 `FROM attendance a JOIN employees e ON e.id = a.employee_id`，聚合欄位為 `a.absence_hours` / `a.overtime_hours` / `a.absence_type` / `a.source`。
- 全 repo 搜尋 `attendance_status`（訓練場次簽到欄位）命中 8 處，**全部落在 `src/server/m1.ts`（教育訓練）與 `migrations/0001`**，`src/server/m4.ts` 一處也沒有。`migrations/0007_m4_reporting_seed.sql:10` 亦特別加註提醒兩者語意不同。
- `source` 欄位確實同時涵蓋手動輸入與 CSV 匯入：實測回應 `bySource: [{"source":"csv",...},{"source":"manual",...}]`。

SQL 對帳（期間 2026-02 ~ 2026-07，無篩選）：

| 指標 | SQL | API | 一致 |
|---|---|---|---|
| 總筆數 | 18 | 18 | ✅ |
| 涉及人數（distinct employee） | 5 | 5 | ✅ |
| 缺勤時數 | 94 | 94 | ✅ |
| 加班時數 | 74 | 74 | ✅ |
| 人資／診所／醫院 筆數 | 4 / 9 / 5 | 4 / 9 / 5 | ✅ |

### R8 — 招募漏斗各階段轉換數

**PASS.** 端點 `GET /api/admin/reports/recruitment-funnel`，沿用 `funnelData()`（`src/server/m3.ts:615`）。

SQL 對帳（`SELECT status/to_status, COUNT(*)` 分別對 `candidate_applications` 與 `candidate_application_status_history`）：

| 階段 | currentCount（SQL／API） | enteredCount（SQL／API） |
|---|---|---|
| applied 投遞 | 1 / 1 | 4 / 4 |
| screening 篩選 | 1 / 1 | 3 / 3 |
| interview 面試 | 1 / 1 | 2 / 2 |
| salary_approval 核薪 | 0 / 0 | 1 / 1 |
| offer 發送錄取 | 1 / 1 | 1 / 1 |
| hired / onboarded | 0 / 0 | 0 / 0 |

逐格一致 ✅。currentCount 合計 4 = 應徵總筆數 4，自洽。

> **附註（seed 資料品質，非 M4 程式缺陷）**：`migrations/0005_m3_recruitment.sql:17` 的 `applied_at` 預設為 `strftime(...,'now')`，因此四筆應徵的投遞時間會等於**跑 migration 的當下時刻**（本次為 `2026-07-27T02:50:31Z`）。後果是在全新 DB 上選任何歷史期間（例如 2026-01~06）漏斗一律全零，要選到含 migration 執行日的期間才看得到數字。驗收時容易被誤判為「漏斗壞掉」。建議 seed 改寫死歷史日期。

### R9 — 教育訓練完成率（全公司／部門）

**PASS，兩種都能算。** 回應同時含 `company` 與 `byDepartment` 兩個區塊（`src/server/m4.ts:337-344`）。

全新 DB 的 `training_records` 為**空表**（`SELECT COUNT(*) FROM training_records` = 0），所以開箱的完成率一律 0%，無法只靠 seed 證明分子有在算。因此我**自行注入 3 筆完訓紀錄**（emp-001 人資 / emp-002 診所 完成於 2026-03；emp-003 醫院 完成於 2026-09）後重測：

| 查詢 | company.completedTotal | 部門明細 |
|---|---|---|
| endMonth=2026-06 | 2（完成率 3.33%） | 人資 1（8.33%）／診所 1（5%）／醫院 0 |
| endMonth=2026-12 | 3（完成率 5%） | 人資 1／診所 1／**醫院 1（3.57%）** |
| department=人資行政部 | 1（8.33%） | 只回人資一列，company 亦收斂為該部門 |

分子、分母、部門切分、以及「以迄月為截止日」的累計語意（2026-09 完成的那筆只在 endMonth=2026-12 出現）**全部正確 ✅**。

> **附註（seed 資料品質）**：fresh DB 完訓紀錄為 0，導致此報表開箱即 0%。建議 seed 補一些 `training_records`，否則驗收者看到全零會誤判。

### R10 — 薪資成本

**PASS.** 端點 `GET /api/admin/reports/salary-cost`。

```sql
SELECT COUNT(*), SUM(salary) FROM employees
WHERE hire_date <= '2026-07-31'
  AND (termination_date IS NULL OR termination_date > '2026-07-31');
-- 12, 646000
```

API：`{"headcount":12,"totalSalary":646000,"averageSalary":53833.33,"missingSalaryCount":0}`。
646000 / 12 = 53833.33 ✅。`byDepartment` 216000+207000+223000 = 646000 ✅；`byGrade` 81000+142000+218000+133000+72000 = 646000 ✅。
以 `grade=G4` 再驗：218000 / 4 人 = 54500，與 API 一致 ✅。

### R11 — 通用篩選逐張確認

**PASS，含 3 個已在程式與 UI 明確標示的合理例外。**

逐張實測（每張都用 `department` / `grade` / `startMonth` / `endMonth` 各打一次，觀察數字是否變動）：

| 報表 | 部門 | 職等 | 迄月 | 起月 | 例外說明 |
|---|---|---|---|---|---|
| 在職人數與人力結構 | ✅ | ✅ | ✅ | ✅（影響 `startTotal`／`netChange`） | 主數字為期末快照，屬設計 |
| 離職率 | ✅ | ✅ | ✅ | ✅ | — |
| 缺勤與加班統計 | ✅ | ✅ | ✅ | ✅ | — |
| 招募漏斗 | ✅ | **不適用** | ✅ | ✅ | 候選人尚非員工、無職等欄位。回應明示 `gradeFilterApplied:false`，UI 卡片寫「職等篩選不適用」（`m4.ts:304-311`） |
| 教育訓練完成率 | ✅ | ✅ | ✅ | **不吃** | 完成率是「截至某日的累計狀態」而非期間流量。UI 卡片寫「只吃迄月，起始月份不影響本報表」（`m4.ts:317`） |
| 薪資成本 | ✅ | ✅ | ✅ | **不吃** | 口徑為期末在職者月薪加總。UI 卡片寫「只吃迄月，不含期間內離職者」（`m4.ts:351`） |

**例外合理性判斷：三個例外都成立且已對使用者揭露**（回應欄位 + 畫面文字兩層），不是被遺漏。共用解析器 `parseReportFilters()`（`m4.ts:105`）確保四個參數對每張報表都被解析與驗證，即使某張不使用該維度。

唯一可改進處：這三個例外只寫在程式碼與畫面上，README 未記錄（與 R6 同一個文件缺口）。

### R12 — 【驗收清單第 9 項】依部門＋期間篩選後實際點擊匯出

**PASS，實際點擊並取得檔案。**

操作序列（Playwright，桌機寬度，admin 已登入）：
1. 側邊欄點「報表」進入報表中心（六張卡片全部渲染，Chart.js 圖表正常）
2. 部門下拉選 **診所事業部**
3. 起始月份填 **2026-03**、結束月份填 **2026-06**（六張卡片標題同步變成「期間 2026-03 ～ 2026-06」）
4. 在「缺勤與加班統計」卡片點 **匯出 CSV** → 下載 `report-attendance-2026-03_2026-06.csv`
5. 同卡片點 **匯出 XLSX** → 下載 `report-attendance-2026-03_2026-06.xlsx`
6. 另在「薪資成本」卡片點 **匯出 XLSX** → 下載 `report-salary-cost-2026-03_2026-06.xlsx`

檔案落點：`D:\.playwright-mcp\`。

**篩選確實有帶進檔案**：attendance 檔的部門段只有「診所事業部」一列、月份段只有 2026-03～06 四列；salary 檔的部門段只有「診所事業部 4 人 207,000」，與畫面數字（總筆數 8／涉及人數 3／缺勤 48／加班 21）逐格相符。

CSV 檔另檢查：**開頭有 UTF-8 BOM**（`ef bb bf`，Excel 開中文不亂碼）、CRLF 換行、23 行內容與畫面一致。

### R13 — XLSX 以獨立工具驗證

**PASS。** 用 Python `zipfile` + `xml.etree.ElementTree` 自寫驗證器（腳本：`%TEMP%\claude\...\scratchpad\verify_xlsx.py`），另以 `openpyxl 3.1.5` 交叉驗證。

`report-attendance-2026-03_2026-06.xlsx`（5,641 bytes）與 `report-salary-cost-2026-03_2026-06.xlsx`（4,039 bytes）兩檔結果：

| 檢查項 | 結果 |
|---|---|
| 檔頭 magic `PK\x03\x04` | ✅ |
| `zipfile.testzip()`（逐成員 CRC 校驗） | ✅ 回傳 `None`（無損毀） |
| 必要組件齊全 | ✅ `[Content_Types].xml`、`_rels/.rels`、`xl/workbook.xml`、`xl/_rels/workbook.xml.rels`、`xl/worksheets/sheet1.xml` |
| 壓縮方式 / 長度自洽 | ✅ 全部 STORED，`file_size` == 實際解出位元組數 |
| 每個 part 皆為合法 XML | ✅ ElementTree 全部 parse 成功 |
| Content-Type Override 宣告 | ✅ workbook 與 worksheet 兩個 PartName 都有正確 MIME |
| 關聯鏈完整 | ✅ `_rels/.rels → xl/workbook.xml`；`workbook.xml.rels: rId1 → worksheets/sheet1.xml`；workbook 內 `r:id="rId1"` 可解析 |
| 工作表名稱中文 | ✅ `缺勤與加班統計`、`薪資成本` |
| 中文字串還原 | ✅ 例：`指標`、`涉及人數`、`診所事業部`、`CSV 匯入`、`人工登錄`、`請假類別`、`事假/特休/病假` 全部正確 |
| 數字為數值型別（非字串） | ✅ openpyxl 讀回皆為 `int`：8, 3, 48, 21, 207000, 51750, 40000… |
| 儲存格座標／空列 | ✅ 空白分隔列以無 `<c>` 的 `<row>` 表示；`dims A1:D23`（attendance）、`A1:C14`（salary） |

openpyxl 能無警告開啟並讀出正確 `sheetnames`/`dimensions`/`max_row`，代表這個自寫產生器（非 SheetJS，`src/client/export.ts`）產出的檔案是真的能被試算表軟體正常解析的，不只是「能下載」。

### R14 — 出缺勤手動輸入 新增／編輯／刪除

**PASS，API 與 UI 兩條路徑都驗過。**

API（UTF-8 payload，避免 Windows console codepage 干擾）：

| 動作 | 端點 | 結果 |
|---|---|---|
| 新增 | `POST /api/admin/reports/attendance/records` | 201，回傳完整紀錄，`source:"manual"`，中文（事假／驗收測試-建立）正確 |
| 更新 | `PATCH .../records/{id}` | 200，缺勤 4→8、假別 事假→特休、備註更新皆生效 |
| 刪除 | `DELETE .../records/{id}` | 200 `{deleted:true}` |
| 重複刪除 | `DELETE .../records/{id}` | 404「找不到指定的出缺勤紀錄。」 |

UI（出缺勤管理頁）：選員工 E007・吳佳蓉 → 日期 2026-06-20 → 缺勤 6／加班 3／假別 病假／備註「UI 驗收新增」→ 點「新增」→ 列表出現該列（來源標示「人工登錄」）；點「編輯」→ 表單標題變「編輯出缺勤紀錄」且帶入原值 → 改缺勤 6→2、備註改「UI 驗收已編輯」→ 點「更新」→ 列表即時反映；點「刪除」→ 跳出繁中確認對話框「確定刪除此筆出缺勤紀錄？此動作無法復原。」→ 確認後列消失並顯示「紀錄已刪除。」

### R15 — 出缺勤 CSV 匯入：逐列錯誤與行號正確性

**PASS，含引號內換行的行號測試。**

送入的 CSV（刻意錯 5 列，第 6 列為跨 3 個實體行的引號欄位）：

```
1: 員工編號,日期,缺勤時數,加班時數,假別,備註
2: E004,2026-04-01,4,0,事假,正常列一            ← 正常
3: ,2026-04-05,4,0,事假,缺員工編號              ← 錯：員工編號空白
4: E004,2026/04/07,4,0,事假,日期格式錯誤        ← 錯：日期格式
5: E004,2026-04-08,-3,0,事假,負數時數           ← 錯：負數
6: E005,2026-04-02,0,3,,"備註跨行第一段         ← 正常，引號欄位跨 6~8 行
7: 備註跨行第二段
8: 備註跨行第三段"
9: E999,2026-04-09,2,0,事假,查無此員工          ← 錯：員工不存在
10: E004,2026-04-10,0,abc,,加班時數非數字        ← 錯：加班時數非數字
11: E006,2026-04-11,2,1,病假,正常列二            ← 正常
```

回應（HTTP 200，整批不中斷）：

```json
{"imported":3,"updated":0,"skipped":5,"errors":[
 {"row":3,"message":"員工編號為必填。"},
 {"row":4,"message":"日期格式須為 YYYY-MM-DD。"},
 {"row":5,"message":"缺勤時數須為非負數字。"},
 {"row":9,"message":"找不到員工編號「E999」的員工資料。"},
 {"row":10,"message":"加班時數須為非負數字。"}]}
```

- **行號 3/4/5/9/10 與原始檔實際行號逐一對得上 ✅**
- **關鍵測試點：引號內換行之後的列。** 第 9 行若用「第幾筆記錄」的邏輯序號會誤報成 7；實際回報 **9**，正確 ✅。第 10 行同理正確。實作在 `src/server/csv.ts:48-57` 以 `quotedNewlines` 累計引號內消耗的換行並計回行號，設計正確。
- 錯誤訊息全為繁體中文，含具體值（「E999」），未裸露 stack trace。
- 跨行備註的內容也正確落庫：`備註跨行第一段\n備註跨行第二段\n備註跨行第三段`。

### R16 — 員工主檔 CSV 匯入（規格 §九）

**PASS。** 端點 `POST /api/admin/employees/import`，必要標題 `員工編號,姓名,Email,部門,職等,職稱,職務類型,到職日,薪資`。

同樣送入含 5 個錯誤列、且第 6~7 行為引號跨行欄位的檔案：

```json
{"imported":2,"updated":0,"skipped":5,"errors":[
 {"row":3,"message":"員工編號為必填。"},
 {"row":4,"message":"Email 格式不正確。"},
 {"row":5,"message":"找不到職務類型「不存在的職務」。"},
 {"row":6,"message":"薪資須為非負整數。"},
 {"row":8,"message":"到職日格式須為 YYYY-MM-DD。"}]}
```

行號 3/4/5/6/8 全部對得上原始檔；**第 8 行（跨行欄位之後）正確回報為 8 而非 7 ✅**（與 R15 共用 `parseCsvTable`）。訊息全繁中。

### R17 — employee token 打每一個 M4 相關 admin 端點

**PASS。** 以 `chiahao.lin@demo.local`（role=employee，已完成改密碼）的 cookie 逐一打，**12 個端點全部 403**：

| # | Method | 端點 | 狀態 |
|---|---|---|---|
| 1 | GET | `/api/admin/reports/headcount` | 403 |
| 2 | GET | `/api/admin/reports/turnover` | 403 |
| 3 | GET | `/api/admin/reports/attendance` | 403 |
| 4 | GET | `/api/admin/reports/recruitment-funnel` | 403 |
| 5 | GET | `/api/admin/reports/training-completion` | 403 |
| 6 | GET | `/api/admin/reports/salary-cost` | 403 |
| 7 | GET | `/api/admin/reports/summary` | 403 |
| 8 | GET | `/api/admin/reports/attendance/records` | 403 |
| 9 | POST | `/api/admin/reports/attendance/import` | 403 |
| 10 | POST | `/api/admin/reports/attendance/records` | 403 |
| 11 | PATCH | `/api/admin/reports/attendance/records/{id}` | 403 |
| 12 | DELETE | `/api/admin/reports/attendance/records/{id}` | 403 |

回應一律 `{"ok":false,"error":{"message":"您沒有執行此操作的權限。"}}`。
未帶 cookie 另測 `GET /api/admin/reports/salary-cost` → **401**「請先登入。」

防護是在路由層 `src/server/router.ts:65-66` 對整個 `/api/admin/` 前綴做 `requireAdmin(user)`，`handleAdminM4` 進入時再 `requireAdmin` 一次（`m4.ts:663`），雙層把關，不是靠前端隱藏。

### R18 — 薪資成本確實 admin-only，員工端無管道取得他人薪資

**PASS。**

- 薪資成本端點：見 R17 第 6 項，403。
- 員工端全部 8 個端點抓回應後 grep `salary`（大小寫不敏感）：`/api/employee/schedule`、`courses/open`、`training-records`、`profile`、`home`、`mandatory-training`、`certifications`、`idp` → **零命中**。
- 唯一會吐出 `salary` 欄位的是 `GET /api/admin/employees`（admin 身分驗證確有 `"salary":72000` 等欄位），employee 身分打該端點 → 403。
- 程式層佐證：`src/server/m1.ts:1205` 註解明示員工自助查詢刻意不 SELECT salary；`m3.ts` 的核薪相關端點全在 `/api/admin/` 前綴下。

### R19 — 錯誤處理（缺必填、超範圍、壞 JSON）

**PASS，全繁中且無 stack trace；有 2 個小瑕疵。**

| 測試 | 狀態碼 | 訊息 |
|---|---|---|
| POST 出缺勤 `{}`（缺必填） | 422 | 日期為必填。 |
| 缺勤時數 `-5`（超範圍） | 422 | 缺勤時數須為非負數字。 |
| 缺勤時數 `"abc"`（型別錯） | 422 | 缺勤時數須為非負數字。 |
| 日期 `2026-13-99` | 422 | 日期格式須為 YYYY-MM-DD。 |
| employeeId 不存在 | 422 | 找不到指定員工。 |
| 壞 JSON（`{"employeeId": `） | 400 | JSON 格式不正確。 |
| 無 Content-Type | 415 | 請使用 application/json 格式送出資料。 |
| `?startMonth=abc` | 422 | startMonth 參數格式須為 YYYY-MM。 |
| `?startMonth=2026-08&endMonth=2026-01` | 422 | 起始月份不可晚於結束月份。 |
| `?startMonth=2026-13` | 422 | startMonth 參數格式須為 YYYY-MM。 |
| CSV 匯入標題列不對 | 400 | CSV 標題列缺少必要欄位：員工編號、日期、缺勤時數、加班時數、假別、備註。 |
| CSV 匯入缺 `csv` 欄位 | 400 | 請提供 csv 欄位（CSV 檔案全文字串）。 |
| 不存在的 M4 路徑 | 404 | 找不到此 API。 |

未預期例外的處理也正確：`src/server/http.ts:27-34` 只把 `{message:"系統暫時無法處理此要求，請稍後再試。"}` 回給前端，真正的錯誤訊息只寫 `console.error`，**不會把 stack trace 送到瀏覽器** ✅。

瑕疵（皆為 Nit，不影響 PASS）：
1. `startMonth`／`endMonth` 的格式錯誤訊息夾雜英文參數名（「startMonth 參數格式須為 YYYY-MM。」），與其他訊息一律用中文欄位標籤（「日期」「缺勤時數」）不一致。建議改為「起始月份」。
2. POST 出缺勤送 `{}` 時只回「日期為必填。」，`employeeId` 也缺卻沒提；因驗證順序把日期擺在前面（`m4.ts:529`）。使用者需修兩次才知道兩個都缺。

### R20 — 375px 手機寬度

**PASS。** 以 Playwright 設 viewport 375×812 實測兩頁，用 JS 量測所有元素的 `getBoundingClientRect()` 與祖先的 `overflow-x`。

**報表中心頁：**
- `documentElement.scrollWidth` = 360 = `clientWidth`；`body` 同。**`pageOverflow: false`，無頁面級水平溢出 ✅**
- 有 53 個元素寬度超出視窗，但**逐一追溯祖先後，全部落在 `overflow-x:auto` 的 `.table-card` 容器內**（未被容器包住的溢出元素數 = **0**），屬題目允許的「容器內捲動」。
- 主要操作全在視窗內：部門／職等下拉、起始月份／結束月份輸入（各 291×51px）、**12 顆匯出按鈕（6 張卡片 × CSV/XLSX，各 140×49px）全部 `inX: true`**、6 張 Chart.js 圖表（288px 寬）也全部不溢出。
- 導覽：`aside` 側邊欄在窄寬度 `display:none`，改由畫面頂部的 `<select>` 下拉切換頁面（含「報表」「出缺勤管理」等 17 個項目），導覽路徑未斷。

**出缺勤管理頁：**
- `pageOverflow: false`，未被容器包住的溢出元素數 = **0** ✅
- 主要操作可觸及：篩選（部門／職等／員工／起迄月份，各 291px）、新增表單全欄位（員工、日期、缺勤時數、加班時數、假別、備註）、**「新增」按鈕**、CSV 區的「下載範本 CSV」「選檔」「開始匯入」——全部 `inX: true`。
- 列內「編輯／刪除」按鈕超出視窗，但實測把 `.table-card`（`scrollWidth 920 / clientWidth 326`）向右捲到底後，按鈕的 `right` 從 878 變 284，**進入視窗且可點擊 ✅**，符合「容器內捲動可接受」。
- 截圖：`D:\.playwright-mcp\m4-attendance-375.png`，版面正常、全繁體中文、無破版。

**主控台**：整個瀏覽器 session 只有 1 個 error，是登入前 `/api/auth/me` 的預期 401；報表頁與出缺勤頁操作期間無任何 JS runtime error。

---

## 其他跨模組要求的順帶查核

| 要求 | 結果 | 依據 |
|---|---|---|
| §二 圖表用 Chart.js 或同級輕量方案 | ✅ | `package.json` `chart.js ^4.5.1`；`src/client/components/Chart.tsx` 只註冊長條圖所需元件、卸載時 `destroy()` |
| §二 Excel 匯出前端產 .xlsx | ✅ | `src/client/export.ts` 純前端產生（自寫 ZIP+OOXML，零第三方相依），檔案已通過 R13 驗證 |
| §二 全站 UI 繁體中文 | ✅ | 報表頁、出缺勤頁、所有錯誤訊息、確認對話框、匯出檔內容皆繁中 |
| §二 響應式（手機可正常操作） | ✅ | 見 R20 |
| §三 薪資 API 層強制 admin-only | ✅ | 見 R17 / R18，router + handler 雙層 `requireAdmin` |
| §七 Admin 側邊欄有「報表」 | ✅ | 側邊欄第 15 項「報表」，點擊可進入報表中心 |
| §九 員工主檔支援 CSV 匯入 | ✅ | 見 R16 |
| §九 錯誤訊息友善繁中、不裸露 stack trace | ✅ | 見 R19 |
| §十-5 employee 只看自己、打 admin API 得 403 | ✅ | 見 R17（403）與 R18（無他人薪資） |
| §十-9 任一報表可依部門＋期間篩選並匯出 CSV/XLSX | ✅ | 見 R12 / R13 |
| §十-10 375px 各清單頁可正常操作 | ✅ | 見 R20 |

---

## 缺陷清單（依嚴重度）

### 1. [Medium] README 對 M4 的敘述錯誤，且未記錄離職率／平均在職數定義

- `README.md:5` 與 `README.md:155-157` 都聲稱 M4「尚未建立應用路由或頁面」「尚未開始」，與實際不符。
- 規格 R6 明確要求「平均在職數」的定義須記錄在 README，目前 README 零命中。
- 同時，R11 的三個篩選例外（漏斗不吃職等、完成率與薪資成本不吃起月）也只寫在程式碼與畫面，README 未記錄。
- **這是本次唯一的實質 FAIL 項。**

### 2. [Low] `src/server/m4.ts:60` 註解與 SQL 行為矛盾

註解寫「離職當日仍計為在職」，但同行的 SQL 是
`e.hire_date <= ? AND (e.termination_date IS NULL OR e.termination_date > ?)`
——`termination_date > asOf` 在 asOf 等於離職日時為 false，該員**不**計入在職。

SQL 實證：離職日 2026-03-15 的員工，asOf `2026-03-14` 時在職數 17，asOf `2026-03-15` 時 16 → 離職當日已排除。

行為本身是可接受的慣例（離職當日視為已離職），但註解寫反了，會誤導後續維護者調整期初／期末口徑。建議修正註解文字（不必改 SQL）。

### 3. [Low] Seed 資料兩處讓 M4 報表開箱即「全零」，易被誤判為壞掉

- `training_records` 在全新 DB 為**空表** → 教育訓練完成率永遠 0%（R9）。
- `candidate_applications.applied_at` 預設 `strftime(...,'now')`（`migrations/0005:17`）→ 投遞時間等於跑 migration 的當下，選任何歷史期間漏斗都全零（R8）。

兩者皆非 M4 程式缺陷（我注入資料後計算都正確），但建議 seed 補上固定歷史日期的完訓紀錄與應徵時間，讓驗收者一開啟報表就看得到有意義的數字。

### 4. [Nit] 月份參數錯誤訊息夾雜英文參數名

`startMonth 參數格式須為 YYYY-MM。`（`m4.ts:67`）與其他一律中文標籤的訊息不一致，建議改為「起始月份／結束月份」。

### 5. [Nit] 出缺勤必填欄位一次只回報一個錯誤

送 `{}` 只回「日期為必填。」，未同時提示員工也缺（驗證順序見 `m4.ts:529`）。

### 6. [Nit] `src/server/m1.ts:887-906` 有整段重複的 JSDoc

同一段「員工主檔清單（供員工管理頁使用）」註解被貼了兩次（887-896 與 897-906），刪掉其中一份即可。與 M4 無關，順手記錄。

---

## 實際檢查範圍摘要（供判斷覆蓋面）

**打過的 API 端點（共 24 個路徑 × 多組參數）**

- 報表：`/api/admin/reports/{headcount,turnover,attendance,recruitment-funnel,training-completion,salary-cost,summary}`——每支各打無篩選、`startMonth+endMonth`、`+grade=G4`、`+department=…`、以及邊界（`2026-13`、start>end、`abc`）多組
- 出缺勤 CRUD：`GET/POST /api/admin/reports/attendance/records`、`PATCH/DELETE .../records/{id}`（含重複刪除的 404）
- 匯入：`POST /api/admin/reports/attendance/import`、`POST /api/admin/employees/import`
- 認證：`/api/auth/{login,change-password,me,logout}`、`/api/health`
- 員工端（查薪資洩漏）：`/api/employee/{schedule,courses/open,training-records,profile,home,mandatory-training,certifications,idp}`
- 權限：上述 12 個 M4 端點各以 employee cookie 重打一次 + 1 次無 cookie

**跑過的 SQL 對帳查詢（`wrangler d1 execute --local --persist-to .wrangler/state-verify-m4`）**

- 在職人數 by department×grade（R5）
- 離職數 / 期初在職 / 期末在職 三值（R6）
- 離職日邊界 asOf 2026-03-14 vs 2026-03-15（缺陷 2）
- attendance 總計 / by department / by source×absence_type（R7）
- candidate_applications 現況 status 與 status_history to_status 分佈（R8）
- training_records 筆數與日期範圍、mandatory 課程數（R9）；並注入 3 筆測試完訓紀錄
- employees 薪資加總（R10）
- settings `report_default_period_months`（= 6，與預設 6 個月回溯行為相符）
- 表清單、`training_records` schema、`job_types`、`employee_no` 清單

**跑過的指令**：`npm run typecheck`、`npm test`、`npm run build`、`wrangler d1 migrations apply`

**瀏覽器操作（Playwright Chromium）**：admin 登入 → 報表頁六張卡片渲染確認 → 部門+期間篩選 → 3 次實際點擊匯出 → 出缺勤頁 UI 新增/編輯/刪除完整週期 → 375px 兩頁溢出量測與控制項可觸及性量測 → 主控台錯誤檢查

**檔案級驗證**：3 個匯出檔（1 CSV + 2 XLSX），以 Python `zipfile`/`ElementTree` 自寫驗證器 + `openpyxl` 交叉驗證

**讀過的原始碼**：`src/server/m4.ts`（全）、`src/server/csv.ts`（全）、`src/server/router.ts`（全）、`src/client/export.ts`（全）、`src/client/pages/M4AdminPages.tsx`（全）、`src/client/components/Chart.tsx`、`src/server/http.ts`（前 80 行）、`src/server/m1.ts`（`completionData`、員工 CSV 匯入、員工端點區段）、`src/server/m3.ts`（`funnelData`）、`migrations/0005`、`migrations/0007`、`README.md`

## 無法驗證的項目

無。R1–R20 全部完成實測，沒有以「應該可以」帶過的項目。

（R9 的完成率分子與 R8 的漏斗，因 seed 資料不足無法用原始種子直接證明，已改以自行注入資料／改選期間的方式完成實測，過程與資料已記錄於上。）

## 環境清理

- 已終止本次自行啟動的 `wrangler pages dev --port 8791` 程序（只終止該 PID，未做全域 workerd 清理）
- 已刪除 `.wrangler/state-verify-m4`
- 全程未讀寫 `.wrangler/state` 與 `.wrangler/state-manual`
- 匯出檔與截圖保留於 `D:\.playwright-mcp\` 供覆核：
  `report-attendance-2026-03-2026-06.csv`、`report-attendance-2026-03-2026-06.xlsx`、
  `report-salary-cost-2026-03-2026-06.xlsx`、`m4-attendance-375.png`
