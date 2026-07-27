# M5 人才盤點 / 系統設定 / 員工個人資料 — 獨立驗收報告

驗收日期：2026-07-27
驗收者：獨立驗收 agent（未參與實作）
Commit：`ccbccb7`（branch HEAD，工作區 clean）

## 驗收環境

- 隔離資料庫：`.wrangler/state-verify-m5`（全新套用 8 個 migration，未觸碰 `.wrangler/state` 或 `.wrangler/state-manual`）
- 隔離伺服器：`npx wrangler pages dev dist --port 8792 --persist-to .wrangler/state-verify-m5`
- admin：`admin@demo.local` / `AcceptDemo2026!`（首登強制改密碼流程已走過）
- employee：`chiahao.lin@demo.local`（emp-002 林家豪）/ `AcceptDemo2026!`
- 瀏覽器：Claude Browser pane。**限制：此 session 的 pane 不合成畫面，screenshot 不可用**，因此 UI 驗證改以 DOM／CSSOM 讀取 + 派發原生 `input`/`change`/`submit`/`click` 事件驅動真實 Preact handler。此法確實執行元件邏輯與後端 API（每次操作皆有 API 往返與 DB 落地佐證），但**未經像素級目視確認**。
- 收工：僅終止本次啟動的 PID，並刪除 `.wrangler/state-verify-m5`。

---

## 逐條結果

| # | 項目 | 結果 |
|---|------|------|
| S1 | typecheck 四個 project | **PASS** |
| S2 | npm test | **PASS**（132 passed / 14 files，0 fail）|
| S3 | npm run build | **PASS** |
| S4 | 職能模型 CRUD＋可自訂 | **PASS** |
| S5 | 九宮格 3×3＋實際移動＋SQL 對照 | **PASS**（附帶次要缺陷 F-1）|
| S6 | 關鍵職位／多繼任者／三種準備度 | **PASS** |
| S7 | admin 管理全部 IDP | **PASS** |
| S8 | 員工只看得到自己的 IDP | **PASS** |
| S9 | employee token 打 admin talent 端點全 403 | **PASS**（22 talent + 6 其他）|
| S10 | 員工改他人 IDP（合法 status）被擋＋SQL 確認未竄改 | **PASS** |
| S11 | 設定可改且確實生效 | **PASS**（證照提醒；試用期提醒無資料可驗，見說明）|
| S12 | 職務類型映射於設定頁維護＋累進級距可讀 | **PASS** |
| S13 | 刪除使用中職務類型被擋且訊息完整呈現 | **PASS** |
| S14 | 員工可改自己姓名與信箱 | **PASS** |
| S15 | 員工不可改 HR 欄位（SQL 驗證） | **PASS** |
| S16 | 個人資料回應不含 salary | **PASS** |
| S17 | 員工可改密碼並以新密碼登入 | **PASS** |
| S18 | 側邊欄／員工端導覽入口 | **PASS** |
| S19 | 錯誤處理友善繁中、不裸露 stack | **PASS** |
| S20 | 375px 無頁面級水平溢出＋九宮格可操作 | **PASS** |

**結論：S1–S20 全數通過。另發現 2 項次要缺陷（F-1／F-2），皆不影響驗收條款成立，但建議修正。**

---

## 證據

### S1 typecheck
`npm run typecheck` 退出碼 0。該 script 串接四個 project：
`tsconfig.client.json` → `tsconfig.worker.json` → `tsconfig.test.json` → `tsconfig.tools.json`，
以 `&&` 串接，退出碼 0 代表四個皆過。

### S2 / S3
- `npm test`（vitest run）：`Test Files 14 passed (14)` / `Tests 132 passed (132)`，退出碼 0。
- `npm run build`（vite build）：退出碼 0，產出 `dist/assets/index-*.js` 335 kB。
- 註：我第一次用 `--reporter=basic` 失敗，那是 vitest 4 已移除該 reporter，屬我的指令錯誤，非專案問題；改跑 `npm test` 正常。

### S4 職能模型
API：`GET/POST/PATCH/DELETE /api/admin/talent/competencies[/:id]`
- 新增全自訂職位＋自訂職能名稱（`驗收自訂職位` / `自訂職能項目`，皆不在種子清單）→ 201。
- PATCH 改名＋改等級 → 200，SQL `SELECT position_title,competency_name,required_level` 確認落地。
- 重複 (職位, 職能) → 409「此職位已有相同職能項目。」
- DELETE → 200；再 DELETE → 404；SQL count = 0。
- UI（`M5AdminPages.tsx:180-183`）：職位別與職能項目都是自由文字 `<input>`，等級為 1–5 數字輸入，**非寫死下拉清單** → 符合「項目可自訂」。
- UTF-8 往返以檔案 payload 另行驗證無誤（早期輸出的亂碼是我 shell harness 的編碼問題，非系統缺陷）。

### S5 九宮格
**結構**：`M5AdminPages.tsx:208-209` `PERFORMANCE_LEVELS=[1,2,3]`、`POTENTIAL_LEVELS=[3,2,1]`；
實測 DOM `.nine-grid-cell` = **9 格**，`grid-template-columns` = `110px + 3 欄` → 真 3×3（績效為欄、潛力為列，高潛力在上）。

**SQL 全員對照**（`SELECT e.employee_no,e.name,e.status,ng.performance,ng.potential FROM employees e LEFT JOIN nine_grid ng ON ng.employee_id=e.id`）：

| 員工 | SQL perf/pot | 畫面落格 | 相符 |
|---|---|---|---|
| E001 王怡文 | 3/2 | pot2×perf3 | ✓ |
| E002 林家豪 | 3/3 | pot3×perf3 | ✓ |
| E003 陳雅婷 | 2/3 | pot3×perf2 | ✓ |
| E004 張志明 | 2/2 | pot2×perf2 | ✓ |
| E005 李佩珊 | 3/1 | pot1×perf3 | ✓ |
| E006 黃冠宇 | 2/2 | pot2×perf2 | ✓ |
| E007 吳佳蓉 | 1/2 | pot2×perf1 | ✓ |
| E008 劉俊傑 | 1/1 | pot1×perf1 | ✓ |
| E010 楊博翔 | 2/3 | pot3×perf2 | ✓ |
| E012 鄭凱文 | 3/2 | pot2×perf3 | ✓ |
| E014 周承恩 | null | 「尚未定位」清單 | ✓ |
| E015 郭采薇 | null | 「尚未定位」清單 | ✓ |
| E009/E011/E013 | inactive | 未出現（API 僅取 active） | ✓ |

**實際操作下拉移動**（兩次，皆走真實 modal `<select>` + submit）：
1. 劉俊傑 低/低 → 高/高：畫面由 pot1×perf1 移至 pot3×perf3，橫幅「劉俊傑 的九宮格落點已更新。」，SQL `performance=3, potential=3`。
2. **非對稱移動**（用以排除績效／潛力軸對調）劉俊傑 → 績效低(1)/潛力高(3)：畫面落 pot3×perf1（左上），SQL `performance=1, potential=3`。軸向正確、未對調。
3. 375px 下再操作一次（吳佳蓉 → perf3/pot1）亦成功。
所有測試後資料已還原為原始值（最終 SQL 與基線逐筆相同）。

### S6 關鍵職位與繼任者
- 建立關鍵職位 → 201；PATCH 改標題＋風險 high→low → 200；DELETE → 200。
- **同一職位掛 3 位繼任者**（emp-002 / emp-003 / emp-005），三種準備度各一：
  `ready_now`（立即可接任）、`one_two_years`（1-2 年內可接任）、`three_plus_years`（3 年以上可接任），皆 201。
  SQL `SELECT employee_id,readiness FROM successors WHERE key_position_id=...` 三筆齊全。
- `successorCount` 於列表正確顯示 3。
- 重複繼任者 → 409；非法 readiness（`tomorrow`）→ 422。
- 刪除職位後 `SELECT COUNT(*) FROM successors WHERE key_position_id=...` = 0（cascade 正常）。
- UI 實測：種子職位「診所事業部業務主管」列出 3 位繼任者，**每位各有 3 選項準備度下拉**，另有新增繼任者表單。

### S7 IDP（admin）
- `GET /api/admin/talent/idp-plans` 回傳跨員工全部計畫（emp-002 / emp-005 / emp-006）。
- 為 emp-003 建立計畫（含 goal 目標、startDate/dueDate 期限、status 狀態）→ 201。
- 新增行動項目（action / dueDate / status）→ 201。
- PATCH 計畫（status → completed）與 PATCH 項目（status → in_progress）皆 200。
- 期限驗證：dueDate < startDate → 422「預計完成日不可早於起始日。」

### S8 員工端「我的 IDP」只看得到自己的
- `GET /api/employee/idp` → 僅 1 筆計畫，`employeeId` 集合 = {emp-002}，非 emp-002 筆數 = 0。
- 回應不含 `salary` 字串。
- 以 admin 取得他人（emp-003）計畫／項目 ID 後：
  - employee 打 `GET /api/admin/talent/idp-plans?employeeId=emp-003` → **403**。
  - employee 打 `GET /api/employee/idp?employeeId=emp-003`（query 偽造）→ 200 但**仍只回自己的** emp-002 資料，參數被忽略。
  - `GET`／`DELETE`／`POST` 於 employee IDP 路由皆 404（無多餘可寫入口）。
- 未帶 cookie 打 `/api/employee/idp`、`/api/employee/profile`、`/api/admin/talent/nine-grid` 皆 401。

### S9 權限（逐一列出實測端點）
employee token 對 **22 個 admin talent 端點**全數 **403**「您沒有執行此操作的權限。」：

```
GET/POST    /api/admin/talent/competencies
PATCH/DELETE /api/admin/talent/competencies/:id
GET         /api/admin/talent/nine-grid
PUT         /api/admin/talent/nine-grid/:employeeId
GET/POST    /api/admin/talent/key-positions
PATCH/DELETE /api/admin/talent/key-positions/:id
GET/POST    /api/admin/talent/key-positions/:id/successors
PATCH/DELETE /api/admin/talent/successors/:id
GET/POST    /api/admin/talent/idp-plans
GET         /api/admin/talent/idp-plans?employeeId=...
POST        /api/admin/talent/idp-plans/:id/items
PATCH/DELETE /api/admin/talent/idp-plans/:id
PATCH/DELETE /api/admin/talent/idp-items/:id
```

另測 6 個敏感 admin 端點亦全 403：
`GET/PATCH /api/admin/settings`、`GET/POST /api/admin/job-types`、`GET /api/admin/employees`、`GET /api/admin/dashboard`。

結構性保證：`router.ts:66` 在 `path.startsWith("/api/admin/")` 時即 `requireAdmin(user)`，
`m5.ts:652` 與 `settings.ts:137` 另各自再呼叫一次 `requireAdmin`（雙重保險）。

### S10 員工改他人 IDP 項目（使用合法 status）
- 目標：emp-003 名下項目，admin 先將其設為 `action='QA action v2'`, `status='in_progress'`, `employee_notes='admin note'`。
- employee 送 `{"status":"completed","employeeNotes":"HACKED BY EMP002"}`（**status 為合法值**）→ **404「找不到指定 IDP 項目。」**
  程式碼順序（`m5.ts:632-640`）為先 `idpItemStatusValue()` 值域檢查、後所有權查詢；因送出合法值，此 404 確定來自**所有權檢查**而非格式驗證。
- SQL 覆核：`action='QA action v2'`、`due_date='2026-07-31'`、`status='in_progress'`、`employee_notes='admin note'` — **完全未被竄改**。
- 對照組：employee 改**自己**的項目（idpi-01）合法 status → 200，SQL 落地成功。
- 額外：employee 對自己項目夾帶 `action`／`dueDate` → 200 但 SQL 顯示 `action` 仍為「參加中階主管管理課程」、`due_date` 未變（白名單寫在 SQL 層，`m5.ts:641-643` 只 UPDATE status 與 employee_notes）。

### S11 設定生效
以 `PATCH /api/admin/settings` 改 `certification_reminder_days`，再讀 `GET /api/admin/dashboard`。
資料面：在職員工證照到期距今 25 天（林家豪）、275 天（陳雅婷）、305 天（李佩珊）。

| 設定值 | 儀表板提醒筆數 | 內容 |
|---|---|---|
| 10 | 0 | （無）|
| 60 | 1 | 林家豪(25d) |
| 300 | 2 | 林家豪(25d)、陳雅婷(275d) |
| 400 | 3 | 三筆全數 |

提醒範圍確實隨設定連動；SQL 確認 `settings.setting_value` 已寫入。
型別驗證：對 number 欄位送字串 → 422；未知 key → 404。測試後已還原 60／14。

> **無法驗證的子項**：`probation_reminder_days` 改 1 與 400 皆回 0 筆。原因是種子資料 4 位 candidates 狀態為 applied/screening/interview/offer，**沒有任何已到職／試用期中的對象**，非程式缺陷。規格與本條指名的例子（證照提醒天數）已完整驗證。

### S12 職務類型映射（§四 4.1「不要寫死」）
- 資料表：`job_types(id, name, required_level, active)`，種子 `內勤=1`、`診所線=2`、`醫院線=3`，與規格累進定義一致。**非程式碼常數**。
- 設定頁 `SystemSettingsPage` 由 `GeneralSettingsPanel` + `JobTypesPanel` 組成，後者提供完整 CRUD。
- **UI 實測（真實表單操作）**：
  - 新增「長照事業線QA」+ 級距 3 → 橫幅「職務類型已建立。」，列表新增該列。
  - 編輯改為級距 2 → 橫幅「職務類型已更新。」，級距條由 `低+中+高` 變 `低+中`。
  - 測試後已刪除，列表回復為內勤／診所線／醫院線三筆。
- **累進級距可讀性佳**：
  - 下拉選項文字即說明累進：`低（僅低階必修課程）`／`低＋中（累進，低階與中階必修課程皆須完成）`／`低＋中＋高（累進，低、中、高三階必修課程皆須完成）`。
  - 列表以三段式進度條呈現，實測 `.filled` class 與底色逐級遞進：
    內勤 = 低[FILLED] 中[empty] 高[empty]；診所線 = 低[FILLED] 中[FILLED] 高[empty]；醫院線 = 三段全 FILLED，且三段底色互異。
  - 另有提示：「職務類型決定必修級距，且級距為累進關係。」與「調整必修級距不會回溯變更既有場次的應上名單」。

### S13 刪除使用中的職務類型
UI 實測刪除「內勤」（5 位員工使用中）：
- 顯示於 `.alert error` 元素，**完整訊息**：
  「此職務類型目前有 5 位員工使用中，請先變更這些員工的職務類型後再刪除。」
- 該列仍在列表中（未被刪除）。
- 後端 `m1.ts:1169-1179` 先 COUNT 再擋，回 409；前端 `SettingsAdminPages.tsx:205-209` 明確處理 409 並顯示 `caught.message`（非通用文案）。
- 對照組：刪除 0 位員工使用的「長照事業線QA」→ 成功，訊息「職務類型「長照事業線QA」已刪除。」

### S14 / S15 / S16 員工個人資料
基線 SQL（emp-002）：`E002 / 林家豪 / chiahao.lin@demo.local / 診所事業部 / G5 / 資深業務代表 / jt-clinic / salary=65000 / active / 2021-05-10 / termination=null`

- **S14**：PATCH `{"name":"林家豪改名測試","email":"chiahao.qa@demo.local"}` → 200，SQL 確認兩欄皆更新。UI 個人資料頁亦僅「姓名」與「聯絡信箱」兩個可編輯 input。
- **S15**：PATCH 夾帶
  `department=董事長室, grade=P10, title=執行長, jobTypeId=jt-hospital, salary=9999999, status=inactive, hireDate=2000-01-01, employeeNo=E999, terminationDate=2030-01-01`
  → 200，但 **SQL 直查確認全部未寫入**：
  `employee_no=E002, department=診所事業部, grade=G5, title=資深業務代表, job_type_id=jt-clinic, salary=65000, status=active, hire_date=2021-05-10, termination_date=null`（僅 name/email 依白名單變更）。
  防護做在 SQL 層（`m1.ts:1240-1243` UPDATE 只列 name、email），非邏輯層過濾。
  另確認無旁路：`PUT/POST/DELETE /api/employee/profile` 皆 404、`PATCH /api/employee/employees/:id` 404、`PATCH /api/admin/employees/emp-002`（員工身分）403。
- **S16**：`GET /api/employee/profile` 回傳欄位為
  `id, employeeNo, name, email, department, grade, title, jobTypeId, jobType, hireDate, terminationDate, status`
  — **無 salary key，整段 raw JSON 亦不含 "salary" 字串**（`getEmployeeProfile` 的 SELECT 刻意不取該欄）。個人資料頁畫面也不含「薪資」或 65000。
- 測試後已還原姓名與信箱為原值。

### S17 變更密碼
個人資料頁 `ChangePasswordPanel` 走 `POST /api/auth/change-password`。
- 以員工 session 改 `AcceptDemo2026!` → `EmpQaPass2026!` → 200。
- 以**新密碼**登入 → 200；以**舊密碼**登入 → 401。
- 目前密碼填錯 → 401「目前密碼錯誤。」
- 新密碼過弱（`abc`）→ 422「新密碼至少 10 碼，且須包含大小寫英文字母、數字與符號。」
- 測試後已改回 `AcceptDemo2026!`。

### S18 導覽入口（規格 §七）
- **Admin 側邊欄**（實際 DOM 讀取）：管理儀表板／員工管理／排課月曆／課程管理／出席登錄／完訓追蹤／必修訓練清單／報名審核／測驗紀錄／證照管理／訓練矩陣／招募管理／重要日子／出缺勤管理／報表／**人才盤點**／**系統設定**。
  人才盤點下含四個子頁籤：**職能模型／九宮格／關鍵職位與繼任者／IDP 管理**。
- **Employee 導覽**：首頁／我的課表／課程報名／我的訓練紀錄／我的證照／**我的 IDP**／**個人資料**。
- 規格 §七 所列入口全部到位。

### S19 錯誤處理
19 種異常輸入全部回傳結構化 JSON、正確狀態碼、繁體中文訊息，且**無任何 stack trace 洩漏**
（偵測樣式：`at fn (`、`SQLITE_`、`D1_ERROR`、`node_modules`、`.ts:NN`、`stack`、`Error:` — 全數 clean）：

| 情境 | 狀態 | 訊息 |
|---|---|---|
| 缺必填（職能） | 422 | 職位名稱為必填。 |
| 缺必填（IDP goal） | 422 | 目標為必填。 |
| 超範圍 level=6／0 | 422 | 必要職能等級須為 1～5 的整數。 |
| 九宮格 perf=9 | 422 | 績效須為 1～3 的整數。 |
| 九宮格 perf 為字串 | 422 | 績效須為 1～3 的整數。 |
| 日期格式錯 | 422 | 起始日格式須為 YYYY-MM-DD。 |
| 非法 enum | 422 | IDP 計畫狀態必須是 draft、active、completed 或 cancelled。 |
| 不存在的員工 | 404 | 找不到指定員工。 |
| 不存在的 id | 404 | 找不到指定職能項目。 |
| **壞 JSON** | 400 | JSON 格式不正確。 |
| 空 body | 400 | JSON 格式不正確。 |
| JSON 是陣列 | 400 | JSON 格式不正確。 |
| content-type 錯 | 415 | 請使用 application/json 格式送出資料。 |
| 字串超長(300>200) | 422 | 職位名稱不可超過 200 字。 |
| 設定型別錯 | 422 | 設定「timezone」須為文字。 |
| 設定空陣列 | 422 | updates 須為至少一筆的陣列。 |
| 職務級距超範圍 | 422 | 必修級距須為 1～3 的整數。 |
| 未知路由 | 404 | 找不到此 API。 |

`http.ts:20-36` 對非 `ApiError` 一律回統一文案「系統暫時無法處理此要求，請稍後再試。」並僅在 server console 記錄細節。

### S20 375px 響應式
viewport 設為 375×812，量測 `document.documentElement.scrollWidth > clientWidth`，
並掃描所有元素中「右緣超出視窗且其祖先無 `overflow-x:auto/scroll`」者（即真正的頁面級溢出）：

| 頁面 | docScrollWidth | 頁面級溢出 | 容器外溢出元素數 |
|---|---|---|---|
| 人才盤點／職能模型 | 375 | 否 | 0 |
| 人才盤點／九宮格 | 375 | 否 | 0 |
| 人才盤點／關鍵職位與繼任者 | 375 | 否 | 0 |
| 人才盤點／IDP 管理 | 375 | 否 | 0 |
| 系統設定 | 375 | 否 | 0 |
| 員工／我的 IDP | 375 | 否 | 0 |
| 員工／個人資料 | 375 | 否 | 0 |

**九宮格窄螢幕可操作性**：`.nine-grid-scroll` 的 `overflow-x` = `auto`，容器寬 343px、內容寬 480px
→ 屬**容器內捲動（依本次驗收標準可接受）**，非頁面級溢出。
於 375px 下實際完成一次落點指定（吳佳蓉 → 績效高/潛力低），modal 邊界 left=16 / right=359（未超出 375），
下拉可選、儲存成功、格位正確更新 → **窄螢幕仍可指定落點**。

---

## 發現的缺陷（皆不影響 S1–S20 成立，建議修正）

### F-1（次要・UX）九宮格軸標籤由資料推導，空層級會退化為「等級 N」
**位置**：`src/client/pages/M5AdminPages.tsx:228-237`

`performanceLabels` / `potentialLabels` 兩個 `useMemo` 是**從當前回傳的 entries 反推**標籤，
只有「有員工佔用的層級」才會有 低／中／高 對照；其餘落入 `?? \`等級 ${level}\`` fallback。

**實測重現**：把僅有的兩位 potential=1 員工（E005、E008）暫時移到 potential=2 後重載九宮格：
- 列標題變成 `["低","中","高","高","中","等級 1"]` — 潛力「低」列顯示為「**等級 1**」
- modal 潛力下拉選項變成 `1=等級 1`（原應為 `1=低`）

**最壞情況**：全新部署 `nine_grid` 無任何資料時，六個軸標題與六個下拉選項**全部**顯示「等級 N」，
使用者看不出哪一軸是績效／潛力、哪端是高低。（初次載入資料到位前也可觀察到同樣畫面。）

**成因**：後端其實已有權威對照（`m5.ts:50-54` `scoreLabel` 1→低 2→中 3→高），前端未使用常數表。
同檔的 `KeyPositionsPage` 就有正確作法：以常數 `RISK_LABEL` 作 fallback（`M5AdminPages.tsx` 風險等級渲染處）。

**建議**：前端改用固定常數 `["","低","中","高"]`，僅在後端回傳 label 時覆寫，不要反向從資料推導。

### F-2（次要・錯誤處理）裸 `catch` 把任何 DB 錯誤都轉成誤導性的 409
**位置**：`src/server/m5.ts:261-263`（`createCompetency`）、`src/server/m5.ts:461-463`（`createSuccessor`）

```
} catch {
  throw new ApiError(409, "此職位已有相同職能項目。");
}
```

catch 未辨別錯誤型別，因此**任何**插入失敗（磁碟、連線、schema 變更、CHECK 約束等）
都會回報「此職位已有相同職能項目。」使用者與維運都會被導向錯誤方向。
同檔 `updateCompetency`（:282-285）已有較好寫法（先 `if (error instanceof ApiError) throw error`），
但仍未區分「唯一鍵衝突」與其他 DB 錯誤。

**建議**：檢查錯誤訊息是否含 `UNIQUE constraint failed` 再回 409，否則讓它冒泡到 `errorResponse` 回 500 並留下 server log。

### 觀察（非缺陷）員工送出 HR 欄位時回 200 而非 4xx
S15 中員工夾帶 `salary`／`department` 等欄位，API 回 **200** 並靜默忽略。
資料完整性已由 SQL 證實無虞，且「白名單寫在 SQL 層」是比「先驗證再擋」更穩健的作法（原始碼註解亦明示此設計意圖），
規格 §三 只要求這些欄位不可被員工改寫 → **判定 PASS**。
惟回 200 可能掩蓋前端傳錯欄位的 bug，若要更嚴謹可考慮對未知欄位回 422。

---

## 實際檢查範圍摘要

- **靜態**：`src/server/{router,http,m5,settings,auth}.ts`、`src/server/m1.ts`（job types 與 employee profile 段）、
  `src/client/pages/{M5AdminPages,SettingsAdminPages,EmployeeProfilePages,LoginPage}.tsx`、`wrangler.jsonc`、`package.json`、8 個 migration。
- **API**：約 80 次請求，涵蓋 22 個 admin talent 端點（各以 admin 與 employee 雙身分）、
  `/api/admin/settings`、`/api/admin/job-types`、`/api/admin/dashboard`、`/api/employee/{idp,idp/items/:id,profile}`、`/api/auth/{login,change-password}`，
  含未認證、跨身分、query 參數偽造、非法 method 等負面案例。
- **SQL**（全部針對隔離庫 `.wrangler/state-verify-m5`）：
  `employees × nine_grid` 全員 LEFT JOIN 對照、`competency_models`、`successors`、`idp_items`、`idp_plans`、
  `settings`、`job_types`、`employee_certifications` 到期距離、`candidates` 狀態分佈、`sqlite_master` schema 確認。
  S10／S15 的關鍵結論皆以 SQL 直查覆核，未僅憑 API 回應。
- **UI**：admin 與 employee 兩種身分實際登入，操作九宮格落點（3 次，含非對稱與 375px）、
  職務類型新增／編輯／刪除／刪除被擋、職能模型列表、繼任者面板、
  7 個頁面於 375px 的溢出量測。

## 未能驗證的項目

1. **像素級目視**：此 session 的瀏覽器 pane 不合成畫面，`screenshot` 逾時。S20 的結論建立在
   CSSOM／getBoundingClientRect 幾何量測（可靠地判定溢出與元素位置），但**未經肉眼確認視覺美觀或重疊**。
2. **`probation_reminder_days` 端到端生效**：種子無試用期中對象（4 位 candidates 皆停在 applied/screening/interview/offer），
   改動該值時提醒恆為 0 筆，無法區分「設定未生效」與「無符合資料」。S11 以規格指名的證照提醒天數完成驗證。
3. **拖放（drag-and-drop）指定落點**：規格為「下拉**或**拖放」，本實作採下拉，已驗證；未實作拖放，不構成缺項。

## 收工

- 已終止本次啟動的 wrangler PID（未使用全域 `Stop-Process -Name workerd`）。
- 已刪除 `.wrangler/state-verify-m5`。
- 所有測試資料已還原：nine_grid 逐筆回到基線、emp-002 姓名／信箱／密碼復原、
  測試用職能項目／關鍵職位／繼任者／IDP 計畫／職務類型皆已刪除、settings 回復 60／14。
