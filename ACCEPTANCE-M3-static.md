# M3 招募模組 — 靜態結構與前端驗收報告

驗收方式：唯讀（Read / Grep / Glob），未執行 build / test / dev server。
驗收日期：2026-07-25。

---

## S1. `migrations/0005_m3_recruitment.sql` 是否涵蓋 §六 M3 資料表

§六原始清單：`job_openings`、`candidates`、`interviews`／`interview_scores`、`offers`、`onboarding_items`／`onboarding_checklist`、`probations`

實際情況（M3 資料表分散在 `migrations/0001_initial_schema.sql` 建初版 + `migrations/0005_m3_recruitment.sql` 補狀態機／核薪／到職，非全部在 0005）：

| 規格表名 | 實際表名 | 位置 | 備註 |
|---|---|---|---|
| `job_openings` | `job_openings` | 0001:185-194 | 完全相符 |
| `candidates` | `candidates` + `candidate_applications`（新增） | 0001:196-208；0005:1-20 | 拆分為「人才主檔」＋「跨職缺應徵紀錄」，較貼近規格「可跨職缺查詢再利用」的原意 |
| `interviews`／`interview_scores` | `interviews`（0001，0005 加欄）／`interview_scores` | 0001:219-236；0005:88-89 (`application_id`, `notes` 新增欄) | 相符 |
| `offers` | `recruitment_offers`（新表，改名） | 0005:105-114 | 舊 `offers` 表（0001:238-247）**已無任何 API 引用**，形同孤兒表 |
| `onboarding_items`／`onboarding_checklist` | `onboarding_items`（0001 不變）／`application_onboarding_checklist`（新表，改名） | 0001:249-254；0005:116-124 | 舊 `onboarding_checklist`（0001:256-264）**已無任何 API 引用**，形同孤兒表 |
| `probations` | `probations`（0001，0005 加欄） | 0001:266-274；0005:126 (`candidate_application_id` 新增欄) | 相符 |
| （規格未列） | `salary_approvals`（新表） | 0005:91-103 | 為滿足「核薪紀錄」需求新增，合理 |
| （規格未列） | `candidate_application_status_history`（新表） | 0005:48-67 | 狀態機歷程記錄，合理；但舊 `candidate_status_history`（0001:210-217）**已無任何 API 引用**，形同孤兒表 |

**判定：PASS（功能涵蓋齊全），但附帶缺陷** — `migrations/0001_initial_schema.sql` 中的 `offers`、`onboarding_checklist`、`candidate_status_history` 三張表，以及 `candidates.job_opening_id`／`candidates.status` 兩個欄位（0001:202, 205），在 `src/server/m3.ts` 全文搜尋均無任何 `SELECT/INSERT/UPDATE` 引用（已用 Grep 確認 `FROM offers`／`INTO offers`／`onboarding_checklist`（非 `application_` 前綴）／`candidate_status_history` 皆零命中）。0005 用新表整組取代了 0001 的舊設計，但沒有搭配的 migration 清掉或註記淘汰舊表／舊欄位，屬 schema 債務，非阻斷性缺陷。

---

## S2. 各表欄位覆蓋規格點名欄位

- **職缺五欄**（職稱/部門/需求人數/JD/狀態）→ `job_openings.title, department, headcount, description, status`（0001:187-191）。**PASS**，全部具備。
- **候選人六欄**（姓名/聯絡方式/來源/應徵職缺/履歷連結或備註/目前狀態）：
  - 姓名 `candidates.name`（0001:198）
  - 聯絡方式 `candidates.email, phone`（0001:199-200）
  - 來源 `candidates.source`（0001:201）
  - 應徵職缺 `candidate_applications.job_opening_id`（0005:4，非 `candidates.job_opening_id`）
  - 履歷連結或備註 `candidates.resume_url, notes`（0001:203-204）
  - 目前狀態 `candidate_applications.status`（0005:5-16，非 `candidates.status`）
  **PASS**，六欄都有，但分散在兩張表；`candidates` 表自身殘留的 `job_opening_id`／`status`（0001 舊設計）已是死欄位（見 S1）。
- **核薪三欄**（期望/建議/核定薪資）→ `salary_approvals.expected_salary, suggested_salary, approved_salary`（0005:94-96）。**PASS**。
- **試用期**（到職日/長度/到期日/結果）→ `probations.start_date, duration_days, due_date, result`（0001:269-272）。**PASS**。

---

## S3. `src/client/pages/M3AdminPages.tsx` 六子頁區塊

| 子頁 | 元件 | 行號 |
|---|---|---|
| 職缺 | `JobOpeningsPage` | 237 |
| 人才庫 | `TalentPoolPage` | 323 |
| 面試 | `InterviewsPage` | 482 |
| 核薪錄取 | `CompensationOffersPage` | 650 |
| 到職 | `OnboardingPage`（頁內標籤為「到職文件」） | 851 |
| 試用期 | `ProbationsPage` | 1046 |

額外多一個「招募漏斗」總覽頁 `PipelinePage`（151），由容器元件 `RecruitmentPage`（108-149）統一管理分頁切換。

**判定：PASS**，六個子頁全部存在且對應正確。

---

## S4. 六子頁是否為可操作 UI（非空殼）

逐頁確認皆有「表單 + 送出 handler + 呼叫真實 API + 清單渲染」，且 Grep `TODO|FIXME|placeholder|尚未實作|未完成` 於 `M3AdminPages.tsx`、`m3.ts` 均無命中（僅有 6 處 `placeholder="..."` 是 HTML input 提示文字，非未完成標記）：

- 職缺：表單 289-294 → `save()`(253-269) → `POST/PATCH /api/admin/recruitment/job-openings`；清單渲染 296-307。
- 人才庫：表單 404-410 → `save()`(346-362)；搜尋 398-399 → `load()`(332-344)；跨職缺「新增應徵」398-434（inline select + `apply()` 364-381）。
- 面試：表單 575-586 → `save()`(526-542)；多維度評分 606-618 → `saveScores()`(544-557) → `PUT .../interviews/:id/scores`。
- 核薪錄取：核薪表單 808-815 → `saveSalary()`(708-730)；錄取通知表單 819-825，含「產生範本」(732-744)、「複製文字」(764-775, 呼叫 `navigator.clipboard`)、「儲存通知」(746-762)。
- 到職：自訂項目表單 961-966 → `saveItem()`(890-906) → `POST/PATCH /api/admin/recruitment/onboarding-items`；checklist 逐項勾選 994 → `toggle()`(919-934)、備註 998-999 → `saveNote()`(936-951)。
- 試用期：表單 1150-1158 → `save()`(1074-1094)；提醒天數設定 1145 → `saveReminderDays()`(1096-1109)。

**判定：PASS**，六頁均為完整可操作 UI，未發現空殼或未接 API 的區塊。

---

## S5. 側邊欄／路由導覽入口

`src/client/pages/AdminApp.tsx`：主側邊欄 `tabs` 陣列只有**一個**「招募管理」項目（`AdminApp.tsx:69`，`id: "recruitment"`），點擊後渲染 `<RecruitmentPage />`（`AdminApp.tsx:106`，import 自 `M3AdminPages.tsx:12`）。六個子項並非直接列在主側邊欄，而是在 `RecruitmentPage` 內部用二級標籤列（`recruitment-nav`，`role="tablist"`，`M3AdminPages.tsx:128-139`）切換，對應 `sections` 陣列（`M3AdminPages.tsx:110-118`：職缺/人才庫/面試/核薪錄取/到職文件/試用期，外加招募漏斗）。

這與規格 §七原文「招募（職缺、人才庫、面試、核薪錄取、到職、試用期）」的括號寫法一致——即「招募」為一個側邊欄項目，六者為其子項——與同檔案中 M1/M2 其他分頁的實作風格（單層 tab 陣列）也一致。

**判定：PASS**（六個子項都有明確可點擊的導覽入口，但屬「側邊欄→招募管理→頁內二級標籤」兩層結構，並非六個獨立的頂層側邊欄項目，特此註記供覆核判斷）。

---

## S6. M3 前端文案是否全繁體中文

- Grep 簡體字常見字集（国来为这后发与应对时间还没关于价值实现处理创建删除编辑设置数据管理员会话预约资讯网络设计员们）於 `M3AdminPages.tsx`、`m3.ts`：**零命中**。
- Grep 4 字元以上英文字串於 `M3AdminPages.tsx`：命中皆為 TypeScript 型別／識別字／CSS class 名稱（不計入），UI 文字全為繁中。
- 僅 2 處英文字面詞出現在 UI label：「JD」（`M3AdminPages.tsx:293`）與「Email」（`M3AdminPages.tsx:405`）；「JD」為規格書 §五原文用字（`hr-system-prompt.md:94` 逐字使用「JD」），非翻譯遺漏；「Email」為業界慣用縮寫，非需翻譯的完整英文句子。

**判定：PASS**，未發現簡體字或未翻譯英文 UI 字串殘留。

---

## S7. 375px 響應式處理

`src/client/styles.css` 未見字面 `375px`，但有涵蓋此寬度的斷點與捲動設計：

- `@media (max-width: 900px)`（styles.css:292-303）：隱藏側邊欄、顯示 `mobile-header` 的 `<select>` 導覽；`.talent-layout, .interview-layout, .compensation-layout, .onboarding-layout, .probation-layout { grid-template-columns: 1fr }`（styles.css:299）把 M3 六子頁的雙欄表單+清單版面收成單欄。
- `@media (max-width: 600px)`（styles.css:305 起）：進一步調整 `.workspace` padding、`.form-grid` 收成單欄、`.metric-row` 兩欄。375px 落在此斷點內。
- `.recruitment-nav { overflow-x: auto }`（styles.css:251）：六子頁標籤列窄螢幕可橫向捲動，不會擠壓變形。
- `.funnel-grid { overflow-x: auto }`（styles.css:254）、`.recruitment-table { min-width: 820px }`＋外層 `.table-card { overflow-x: auto }`（styles.css:137, 260）：漏斗卡片與招募清單表格在窄螢幕採容器內橫向捲動而非破版。
- `body { min-width: 320px }`（styles.css:21）：頁面本身設下限，避免整頁破版。

**判定：PASS**（有明確響應式依據，但未見專門針對 375px 的斷點測試或註記，是以現有 600px 斷點涵蓋）。

---

## S8. 狀態機階段常數與規格六階段是否一致

規格（`hr-system-prompt.md:100`）：`投遞 → 篩選 → 面試 → 核薪 → 錄取 → 到職`，共 **6** 階段。

實作：
- `src/server/m3.ts:12-20` `PIPELINE_STAGES`：`applied, screening, interview, salary_approval, offer, hired, onboarded` = **7** 階段（另有終態 `rejected`，m3.ts:23）。
- `src/server/m3.ts:35-43` `STAGE_LABELS`：投遞／篩選／面試／核薪／**發送錄取**／**錄取**／到職 = 7 個中文標籤。
- 前端 `src/client/pages/M3AdminPages.tsx:70-79` `STATUS_LABEL` 完全鏡像同一組 7 階段。

差異點：規格的「錄取」被拆成兩階段——`offer`（發送錄取通知）與 `hired`（候選人接受、正式錄取）。README.md:100 與 128 有明確記錄這是刻意的設計決定（"錄取進 hired 前須接受通知"），並非隨意增加。

**判定：FAIL**（依驗收指示「若階段名稱或數量不符，判 FAIL」從嚴認定）——階段數量 7 ≠ 規格 6，即便該差異有 README 記錄且邏輯合理，仍不符合逐字比對規則。

---

## S9. `src/server/m3.ts` 核薪／面試評分／候選人 endpoint 是否都掛 admin-only

雙層防護確認：
1. **路由層**：`src/server/router.ts:62-63`：`if (path.startsWith("/api/admin/")) { requireAdmin(user); ... handleAdminM3(context, path); }`，所有 `/api/admin/*`（含 `/api/admin/recruitment/*`）先過 `requireAdmin`。
2. **Handler 層**：`src/server/m3.ts:1204-1208`，`handleAdminM3` 函式一開頭即呼叫 `requireAdmin(context.user)`，早於任何 path 比對，等同對本檔內每個 endpoint 二次強制檢查。

逐一列出 `handleAdminM3`（m3.ts:1204-1366）內註冊的全部 38 個 endpoint（路徑 → 權限檢查 → 檔案:行號）：

| 路徑 | 方法 | 權限檢查 | 檔案:行號 |
|---|---|---|---|
| /job-openings | GET/POST | 有（router+handler 雙層） | m3.ts:1212-1217 |
| /job-openings/:id | PATCH/DELETE | 有 | m3.ts:1218-1224 |
| /candidates | GET/POST | 有 | m3.ts:1226-1231 |
| /candidates/:id/applications | POST | 有 | m3.ts:1232-1237 |
| /candidates/:id | GET/PATCH/DELETE | 有 | m3.ts:1238-1247 |
| /applications | GET | 有 | m3.ts:1249-1251 |
| /applications/:id/history | GET | 有 | m3.ts:1252-1257 |
| /applications/:id/transition | POST | 有 | m3.ts:1258-1263 |
| /applications/:id/onboarding-checklist | GET | 有 | m3.ts:1264-1269 |
| /applications/:id/onboarding-checklist/:itemId | PUT | 有 | m3.ts:1270-1275 |
| /applications/:id | DELETE | 有 | m3.ts:1276-1279 |
| /funnel | GET | 有 | m3.ts:1280-1282 |
| /interviews | GET/POST | 有 | m3.ts:1284-1289 |
| /interviews/:id/scores | PUT | 有 | m3.ts:1290-1295 |
| /interviews/:id | PATCH/DELETE | 有 | m3.ts:1296-1302 |
| /salary-approvals | GET | 有 | m3.ts:1304-1306 |
| /salary-approvals/:id | PUT/DELETE | 有 | m3.ts:1307-1315 |
| /offers | GET | 有 | m3.ts:1317-1319 |
| /offers/:id/template | GET | 有 | m3.ts:1320-1325 |
| /offers/:id | PUT/DELETE | 有 | m3.ts:1326-1332 |
| /onboarding-items | GET/POST | 有 | m3.ts:1334-1339 |
| /onboarding-items/:id | PATCH/DELETE | 有 | m3.ts:1340-1346 |
| /probations | GET/POST | 有 | m3.ts:1348-1353 |
| /probation-settings | PATCH | 有 | m3.ts:1354-1356 |
| /probations/:id | PATCH/DELETE | 有 | m3.ts:1357-1363 |

另確認 `router.ts` 只 import／呼叫 `handleAdminM3`，全 repo 搜尋 `handleEmployeeM3` 無任何結果——**不存在**任何員工端可觸及 M3 資料的路徑。

**判定：PASS**，無漏檢項目；所有 M3 admin endpoint（含核薪、面試評分、候選人）均有 admin-only 檢查，且為路由層＋handler 層雙重保護。

---

## S10. 是否有「只靠前端隱藏、後端沒擋」的跡象

基於 S9 的結果（全部 endpoint 雙層 admin 檢查、無員工端 M3 路徑），**未發現**任何前端隱藏但後端未擋的敏感資料項目。額外確認：對 `src/client/pages/EmployeeApp.tsx`、`src/client/pages/M2EmployeePages.tsx` 搜尋 `salary|approvedSalary|expectedSalary|suggestedSalary|recruitment` 皆零命中，員工端程式碼完全不觸碰招募/薪資資料。

**判定：PASS（無發現）**。

---

## S11. README 是否記錄 M3 相關「設計決定」

`README.md` 存在（專案根目錄，非只在 node_modules），且有專門的「## 設計決定」章節（README.md:117-131），其中與 M3 直接相關者：

- README.md:127：候選人主檔設計為可重用人才庫，每次應徵另存 `candidate_applications`，避免綁死單一職缺。
- README.md:128：招募狀態機採 forward-only，並列出各階段轉移前置條件（面試需完成評分、核薪需核定薪資、錄取需接受通知、到職需完成必填文件）。
- README.md:129：試用期提醒沿用「on-read 計算」模式，不另建排程服務。

另 README.md:96-105 有完整「## M3 功能」章節逐項說明，含明確寫出 7 段狀態機字串（README.md:100），與 S8 發現的階段數量一致（即該差異是有意識的記錄，非疏漏）。

**判定：PASS**。

---

## S12. 到職 checklist「自訂項目」是否資料模型可自訂

- 主檔存在：`onboarding_items` 表（migrations/0001_initial_schema.sql:249-254），有 `id, name UNIQUE, required, active` 欄位，是獨立主檔而非寫死列舉。
- 對應表：`application_onboarding_checklist`（migrations/0005_m3_recruitment.sql:116-124）以 `onboarding_item_id` 外鍵參照主檔，逐應徵紀錄勾稽。
- CRUD API：`createOnboardingItem`（m3.ts:968-979）、`updateOnboardingItem`（m3.ts:981-993）、`archiveOnboardingItem`（m3.ts:995-1001，軟停用保留歷史勾稽）。
- 前端表單：`M3AdminPages.tsx:959-967`「自訂文件項目」表單（名稱／必填／啟用），送出至上述 API；清單於 `M3AdminPages.tsx:968-978` 即時渲染，並可編輯／停用。
- Checklist 查詢會動態 `LEFT JOIN` 主檔目前啟用項目（m3.ts:1003-1016 `onboardingChecklist`），新增項目後既有／後續應徵紀錄都能立即勾稽，非寫死清單。

**判定：PASS**，到職文件項目為真正資料庫可自訂（admin 可新增/編輯/停用），非寫死固定清單。

---

## 總結

| 項目 | 結果 |
|---|---|
| S1 資料表涵蓋 | PASS（附帶 3 張孤兒表 + 2 個死欄位的 schema 債務，見上） |
| S2 欄位覆蓋 | PASS |
| S3 六子頁存在 | PASS |
| S4 可操作 UI | PASS |
| S5 導覽入口 | PASS（兩層結構，非六個頂層項目，見上註記） |
| S6 繁體中文 | PASS |
| S7 375px 響應式 | PASS（依現有 600px 斷點涵蓋，非專屬 375px 斷點） |
| S8 狀態機一致性 | **FAIL**（7 階段 ≠ 規格 6 階段，從嚴認定） |
| S9 admin-only 檢查 | PASS（全 38 個 endpoint 皆雙層防護，無漏檢） |
| S10 前端隱藏跡象 | PASS（無發現） |
| S11 README 設計決定 | PASS |
| S12 到職項目可自訂 | PASS |

**淨結論**：M3 骨架的 CRUD／狀態流／權限防護／響應式／文件記錄均已到位且品質不錯，唯一明確 FAIL 是 S8（狀態機階段數與規格逐字不符，雖有合理理由與 README 記錄）。另有 S1 提及的 schema 債務（3 張孤兒表：`offers`／`onboarding_checklist`／`candidate_status_history`，2 個死欄位：`candidates.job_opening_id`／`candidates.status`）與 S5 提及的側邊欄兩層巢狀結構，建議人工複核是否可接受。

---

## 驗收範圍紀錄（實際讀取與搜尋）

**讀取檔案**：
- `C:\Users\BDAIPC\hr-system-prompt.md`（全文）
- `D:\hr-system\migrations\0001_initial_schema.sql`（全文）
- `D:\hr-system\migrations\0005_m3_recruitment.sql`（全文）
- `D:\hr-system\src\server\m3.ts`（全文，1367 行）
- `D:\hr-system\src\server\router.ts`（全文）
- `D:\hr-system\src\server\http.ts`（全文）
- `D:\hr-system\src\client\pages\M3AdminPages.tsx`（全文，1182 行）
- `D:\hr-system\src\client\pages\AdminApp.tsx`（全文，479 行）
- `D:\hr-system\src\client\styles.css`（重點段落：1-160, 240-320）
- `D:\hr-system\README.md`（全文）

**Glob**：`D:\hr-system\**\*`（專案結構）、`D:\hr-system\src\**\*`、`D:\hr-system\migrations\*`、`D:\hr-system\*.md`

**Grep 關鍵字**：
- `TODO|FIXME|placeholder|尚未實作|未完成|coming soon|WIP`（M3AdminPages.tsx, m3.ts）
- 簡體字字集 `[国来为这后发与应对时间还没关于价值实现处理创建删除编辑设置数据管理员会话预约资讯网络设计员们]`（M3AdminPages.tsx, m3.ts）
- `[A-Za-z]{4,}`（M3AdminPages.tsx，檢查殘留英文 UI 字串）
- `@media|max-width|min-width|375px|overflow-x`（styles.css）
- `recruitment|salary_approvals|recruitment_offers|candidate_applications`（全 src，確認引用範圍）
- `handleEmployeeM3|EmployeeM3|/api/employee/recruitment`（全 src，確認無員工端路徑）
- `salary|approvedSalary|expectedSalary|suggestedSalary`（EmployeeApp.tsx，確認員工端無薪資欄位）
- `candidate_status_history`、`onboarding_checklist`、`FROM offers|INTO offers|JOIN offers`（m3.ts，確認舊表是否仍被引用）

**未做**：未執行任何 build/typecheck/test/dev server（依指示唯讀驗收，避免與另一 agent 搶資源）；未檢查 `src/client/api.ts`、`src/server/types.ts`、`src/client/types.ts` 內部細節（僅在必要處間接引用，未逐行審閱）；未驗證 seed 資料（`0003_seed.sql`）是否含 M3 種子資料（不在本次 S1-S12 清單內）。
