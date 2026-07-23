# HR 系統 M2 交付範圍驗收報告

驗收對象：D:\hr-system — M2 教育訓練與證照管理（必修清單、課程報名審核、測驗紀錄、證照管理與到期提醒、職務別訓練矩陣）
驗收日期：2026-07-23
驗收方式：實際執行指令、實際打 API（非純讀 code）
驗收前處理：本機 `.wrangler/state` 殘留前次（M1）驗收留下的已改密碼與髒測試資料，已刪除並重新 `wrangler d1 migrations apply DB --local` 建立乾淨 seed 狀態，確保本次結果不受前次操作污染。

---

## 一、程式碼類驗證

### 1. `npm run typecheck`
**PASS**。`tsc -p tsconfig.client.json / tsconfig.worker.json / tsconfig.test.json / tsconfig.tools.json --noEmit` 全部無錯誤輸出。

### 2. `npm test`
**PASS**。`vitest run` → 4 個測試檔（`auth.test.ts`、`m1.test.ts`、`m2.test.ts`、`m2-ui.test.mjs`），共 18 個測試全數通過。此即規格要求的 M1 回歸抽測（`m1.test.ts` 涵蓋在整體 run 中）。

### 3. `npm run build`
**PASS**。`vite build` 成功產出 `dist/index.html`、`dist/assets/*.css`、`dist/assets/*.js`，無錯誤。

### 4. Migration 套用狀態
**PASS**。`npx wrangler d1 migrations list DB --local` → `✅ No migrations to apply!`，確認 `0001_initial_schema.sql`、`0002_indexes.sql`、`0003_seed.sql`、`0004_m2_enrollment_review.sql` 全部四個 migration（含 M2 專用的 0004）皆已套用。`0004` 內容：`enrollments` 表新增 `reviewed_by`／`reviewed_at`／`review_note` 欄位＋審核佇列索引，對應報名審核紀錄需求。

---

## 二、API 實測（`npx wrangler pages dev dist --port 8788`，測畢已 `taskkill` 關閉並以 `netstat` 確認 port 8788 釋放）

帳號：admin（`admin@demo.local`）、emp-002 林家豪／診所線（`chiahao.lin@demo.local`）、emp-003 陳雅婷／醫院線（`yating.chen@demo.local`），皆先完成首次登入強制改密碼流程。

### 必修訓練清單 — **PASS**
`GET /api/admin/mandatory-training` 與 `GET /api/employee/mandatory-training`（emp-002 自己查）結果一致：emp-002（診所線，requiredLevel=2）必修課清單為低級 3 門（`course-01/02/03`）＋中級 2 門（`course-04/05`），共 5 門，不含任何高級課，逐課附 `completed` 狀態（初始皆 `false`），`completionRate: 0`。累進式級距邏輯（低＋中）與完成狀態對照皆正確。
證據：`src/server/m2.ts:247-344`（`mandatoryTraining`，`c.competency_level <= jt.required_level` 累進 JOIN）。

### 課程報名審核（可切換）— **PASS**
1. `PATCH /api/admin/training-settings` 設 `electiveEnrollmentRequiresApproval:true`。
2. emp-002 `POST /api/employee/course-sessions/cs-03/enroll`（選修課「簡報與說服力工作坊」）→ 回傳 `enrollmentStatus:"waitlisted"`。
3. `GET /api/admin/enrollment-requests` → 出現該筆待審，`status:"waitlisted"`。
4. `PATCH /api/admin/enrollment-requests/{id}` `{"action":"approve"}` → 回傳 `status:"enrolled"`，並記錄 `reviewedAt`/`reviewNote`。
5. 切回 `electiveEnrollmentRequiresApproval:false`，emp-002 報名另一選修課（cs-05）→ 直接回傳 `enrollmentStatus:"enrolled"`（無需審核）。
兩種模式切換皆驗證成功。
證據：`src/server/m2.ts:374-443`（`decideEnrollment`，核准時重查時段衝突與名額）、`src/server/m1.ts:920-965`（`enrollSelf` 依設定決定初始狀態）。

### 測驗紀錄 — **PASS**
於場次 `cs-01` 建立測驗（`passingScore:70`），登錄兩筆成績：emp-002 = 85 分、emp-003 = 50 分。
`GET /api/admin/tests?sessionId=cs-01` 回應：emp-002 `passed:1, retrainingRequired:0`；emp-003 `passed:0, retrainingRequired:1`。不過門檻者正確標記需補訓。
證據：`src/server/m2.ts:525-571`（`recordTestResults`，`passed = score >= passingScore`，未過即 `retraining_required:1`）。

### 證照管理（CRUD）— **PASS**
證照類型（`certification-types`）與員工證照（`employee-certifications`）皆完成建立→更新→刪除全流程實測，回應與 HTTP 狀態皆正確（201/200，刪除回 `{deleted:true}` 或 `{archived:true}`）。

### 到期提醒（驗收清單第 7 項）— **PASS**
Seed 資料 `ec-01`（emp-002，GDP 證照）到期日距今 25 天，落在預設提醒天數 60 天內：
- `GET /api/admin/dashboard` 的 `certificationReminders` 含該筆（`daysUntilExpiry:25`）。
- emp-002 `GET /api/employee/home` 的 `certificationReminders` 亦含該筆。
- emp-003（其他員工）`GET /api/employee/home` 的 `certificationReminders` 為空陣列 `[]`；`GET /api/employee/certifications` 也只回自己的證照（`ec-02`），未含 emp-002 的 `ec-01`——確認跨員工資料隔離。

### 提醒天數可設定 — **PASS**
`PATCH /api/admin/training-settings` 將 `certificationReminderDays` 改為 10 後，admin 儀表板與 emp-002 首頁的 `certificationReminders` 皆變為空陣列（該筆 25 天到期證照被正確排除）；改回 60 後測試完畢。
證據：`src/server/m2.ts:197-219`（`expiryReminders`，`date(ec.expires_at) <= date('now', '+' || ? || ' day')` 使用可設定天數）。

### 職務別訓練矩陣 — **PASS**
`GET /api/admin/training-matrix` 回應含 `jobTypes`（內勤/診所線/醫院線＋人數）、`courses`（僅必修課）、`cells`（每格 `required`／`employeeCount`／`completedCount`／`completionRate`／`status`）。內勤（jt-office）對中級課（`course-04/05`）與高級課（`course-07/08`）的 `required:false`、`completionRate:null`、`status:"not_required"`；前端 `M2AdminPages.tsx:353` 對應渲染為「—」＋「非必修」文字，符合「內勤對中高級課應顯示不適用」要求。紅黃綠燈門檻（≥80 綠、≥50 黃、否則紅）與規格一致。
證據：`src/server/m2.ts:752-812`（`trainingMatrix`）、`src/client/pages/M2AdminPages.tsx:353`。

### 權限隔離 — **PASS**
以 emp-002 token 打下列 admin-only M2 API，全部回 `403`：`/api/admin/dashboard`、`/api/admin/training-matrix`、`/api/admin/mandatory-training`、`POST /api/admin/employee-certifications`、`PATCH /api/admin/training-settings`。以 emp-003 token 帶 `?employeeId=emp-002` 查詢 admin 證照清單同樣 `403`（employee 角色完全無法進入 admin 端點，非僅資料過濾）。

---

## 三、逐條結論彙總

| 項目 | 結果 |
|---|---|
| npm run typecheck | PASS |
| npm test（18/18，含 M1 回歸） | PASS |
| npm run build | PASS |
| migration 全套用（含 0004） | PASS |
| 必修訓練清單（累進級距＋完成狀態） | PASS |
| 課程報名：需審核模式（待審→核准生效） | PASS |
| 課程報名：直接放行模式 | PASS |
| 測驗紀錄：通過門檻與不通過標記需補訓 | PASS |
| 證照管理 CRUD | PASS |
| 驗收清單第 7 項：admin 儀表板提醒 | PASS |
| 驗收清單第 7 項：員工首頁提醒 | PASS |
| 跨員工證照資料隔離（emp-003 看不到 emp-002 證照） | PASS |
| 提醒天數可設定（改 10 天後 25 天到期證照不再提醒） | PASS |
| 職務別訓練矩陣：交叉表＋完成度＋紅黃綠燈 | PASS |
| 職務別訓練矩陣：內勤對中高級課顯示不適用 | PASS |
| M2 admin-only API 對 employee token 回 403 | PASS |

**無 FAIL 項目。**

---

## 四、實際檢查範圍說明

- 執行 `npm run typecheck`、`npm test`、`npm run build`，皆為實際指令執行並讀取完整輸出。
- 用 `npx wrangler d1 migrations list DB --local` 確認四個 migration（含 M2 專用 `0004_m2_enrollment_review.sql`）皆已套用；驗收開始前先清除本機 `.wrangler/state` 殘留（前次 M1 驗收留下的已變更密碼與測試資料）並重新套用全部 migration，取得乾淨 seed 狀態再測試。
- 啟動 `npx wrangler pages dev dist --port 8788`，以 admin、emp-002（診所線）、emp-003（醫院線，作為「其他員工」隔離對照組）三組 session cookie 實際發送 HTTP 請求，涵蓋：必修清單查詢、報名審核設定切換＋兩種模式各報名一次、測驗建立與成績登錄（一過一不過）、證照類型與員工證照完整 CRUD、到期提醒（含跨員工隔離與天數可設定）、訓練矩陣、以及 5 個 admin-only M2 端點的 403 權限檢查。逐一比對 HTTP 狀態碼與回應 JSON，而非只讀原始碼推測行為。
- M1 回歸依規格指示僅用測試套件抽測（`npm test` 內含 `m1.test.ts`），另外對 `GET /api/admin/course-sessions` 與 `GET /api/employee/schedule` 做了存活性 spot check（皆 200），未逐條重跑 M1 驗收報告中的 10 條驗收清單。
- 測試完成後以 `taskkill` 關閉 dev server，並用 `netstat` 確認 port 8788 監聽已釋放。
- 未測試 M3～M5（不在本次驗收範圍）。
- 未測試遠端（`--remote`）部署流程，僅本機驗證。

## 五、發現的問題

無功能性 FAIL。過程中一個環境層問題與應用程式無關：透過 Git Bash 的 `curl -d` 傳遞含中文的 JSON body 時，中文字元會被 shell 層破壞編碼（例如建立測驗名稱「新進同仁測驗」存成亂碼），這與 M1 驗收報告記載的現象相同，是本機 Bash 工具傳遞 UTF-8 參數的已知限制，不影響本次任何一條驗收判定（改用非中文文字或檔案方式即可正確送出 UTF-8，且此問題與 M2 程式邏輯無關）。
