# HR 學習排課與人資管理系統

Cloudflare Pages 靜態 SPA（Preact + Vite）與 Pages Functions REST API，資料儲存在 Cloudflare D1。全站介面為繁體中文，時區固定為 `Asia/Taipei`。

目前已完成 repo／Wrangler／schema 與 seed、Auth／RBAC、M1 學習排課、M2 教育訓練／證照管理，以及 M3 招募管理。M4～M5 仍只有既有 schema，尚未建立應用路由或頁面。

## 快速開始

需求：Node.js 20+、npm、Cloudflare 帳號（遠端部署時）。

```bash
npm install
npm run wrangler:types
npm run db:migrate:local
npm run dev
```

開啟終端顯示的本機網址。`npm run dev` 會先建置 SPA，再以 `wrangler pages dev dist` 啟動 Pages 與 Functions；本機 D1 狀態放在 `.wrangler/state`。

### Demo 帳號

- Admin：`admin@demo.local`
- Employee：`chiahao.lin@demo.local`（其他員工帳號請見 seed）
- 初始密碼：`Demo1234!`

所有 seed 帳號首次登入都必須變更密碼（規格要求，見「設計決定」）。

### 本機實測的密碼約定

強制首次改密碼會帶來一個實務問題：**改過的密碼沒有找回途徑**。若在本機實測時改了密碼卻沒留存，下一次（或下一位開發者）就登不進去。

因此本專案約定：

- 本機實測一律把 demo 帳號的新密碼設為 **`AcceptDemo2026!`**
- 忘記或登不進去時，不要嘗試猜密碼，直接重置本機資料庫：

```bash
npm run db:reset:local
```

該指令會刪除 `.wrangler/state/v3/d1` 並重跑所有 migration，取回乾淨的種子資料（初始密碼回到 `Demo1234!`）。**它只動本機模擬狀態，不會碰到任何遠端資料庫。**

若執行時出現 `EPERM／Permission denied`，代表本機 D1 檔案仍被佔用。請先關閉正在執行的 `wrangler pages dev`；Windows 上有時 `workerd` 程序會殘留，需另外終止：

```bash
powershell -Command "Get-Process workerd -ErrorAction SilentlyContinue | Stop-Process -Force"
```

## 常用指令

```bash
npm run build                  # Vite production build
npm run typecheck              # client / Worker / test / tooling 型別檢查
npm test                       # Workers runtime + 真實 D1 binding 測試
npm run wrangler:check         # 編譯 Pages Functions
npm run db:migrations:list     # 查詢本機待套 migration
npm run db:migrate:local       # 套用本機 D1 migration
npm run db:reset:local         # 重置本機 D1 並重跑 migration（只動本機）
```

## 建立 D1 與部署

1. 登入 Cloudflare，建立 D1：

   ```bash
   npx wrangler login
   npx wrangler d1 create hr-system
   ```

2. 將指令回傳的 `database_id` 寫入 `wrangler.jsonc`，取代開發用的全零 placeholder。
3. 重新產生 binding types 並套用遠端 migration：

   ```bash
   npm run wrangler:types
   npx wrangler d1 migrations apply DB --remote
   ```

4. 首次建立 Pages project（已存在可略過）並部署：

   ```bash
   npx wrangler pages project create hr-system --production-branch main
   npm run deploy
   ```

5. 在 Cloudflare Dashboard 的 **Workers & Pages → hr-system → Custom domains** 加入自訂網域（範例 `hr.example.com`）。網域可改，seed 的 `settings.custom_domain` 只是預設值。

部署前不要將真實憑證寫入 repo；未來若加入 secret，使用 `wrangler secret`／Pages Secrets。

## M1 功能

- 課程 CRUD：低／中／高、必選修、時數、講師、說明、關聯證照、完成效期、報名開關。
- 月曆與清單：場次與重要日子，日期點擊快速開課，手機寬度可操作。
- 累進式自動指派：必修課依 D1 的 `job_types.required_level` 計算；全員必訓日改為全體在職員工。
- 封鎖日：API 層阻止新增或移入場次，回傳設定原因。
- 衝突檢查：同員工同日重疊時段回 `409`；HR 可附原因強制覆寫，寫入 `conflict_overrides` 與 `audit_logs`。
- 出席登錄：完成／缺席／請假；完成會 upsert `training_records`，修正為非完成會移除該場完訓紀錄。
- 完訓追蹤：依員工職務級距計算必修數、已完成數、完成率與未完成課程，可依部門篩選。
- 員工端：自己的月曆／清單課表、選修課名額內先到先得報名、自己的訓練紀錄與必修完成率。

## Auth 與資料保護

- 密碼使用 PBKDF2-SHA256（每位使用者獨立 salt、至少 100,000 iterations）。
- 隨機 session token 只在瀏覽器 HttpOnly、SameSite=Strict cookie；D1 僅存 SHA-256 token hash。
- 所有 admin API 在 API 層驗證角色；employee API 從 session 的 `employee_id` 決定資料範圍，不接受前端傳入他人 ID。
- mutation 檢查 `Origin` 並限定 JSON body；錯誤訊息不回傳 stack trace。
- 核薪與薪酬資料僅能透過 M3 admin API 讀寫；employee API 不查詢或回傳任何薪資資料。

## M2 功能

- 必修訓練清單：依 D1 的 `job_types.required_level` 累進推導每位員工的必修課，逐課顯示完成／未完成及整體完成率，可依部門篩選。
- 選修報名流程：`settings.elective_enrollment_requires_approval` 可切換直接核准或 HR 審核；審核模式使用 `waitlisted` 狀態，核准時重新檢查名額與時段衝突，並保留審核人、時間、備註與 audit log。
- 測驗紀錄：測驗關聯開課場次，可維護通過門檻並批次登錄參訓員工分數；低於門檻會自動標記不通過與需補訓。
- 證照管理：證照類型與員工證照 CRUD，包含名稱、發證單位、證號、取得日、到期日與備註。
- 到期提醒：`settings.certification_reminder_days` 預設 60 天；admin 管理儀表板與該員工首頁使用相同提醒規則，逾期項目也會持續顯示。
- 職務別訓練矩陣：職務類型 × 必修課交叉表，依在職員工完成數計算每格百分比；綠燈 ≥ 80%、黃燈 ≥ 50%、紅燈 < 50%，非該職務必修顯示 `—`。
- 員工端：首頁顯示自己的證照提醒、必修逐課狀態與近期場次數；另有完整證照清單與報名審核狀態。

## M3 功能

- 職缺管理：職稱、部門、需求人數、JD 與開放／暫停／關閉狀態的完整 CRUD。
- 履歷人才庫：候選人聯絡資料、來源、履歷連結與備註可搜尋維護；`candidate_applications` 將人才與職缺分離，同一候選人可跨多個職缺重複使用。
- 招募狀態機：`投遞 → 篩選 → 面試 → 核薪 → 發送錄取 → 錄取 → 到職` 逐步轉移，另可於流程中淘汰；每次轉移均保留操作者、時間與備註。
- 面試管理：依應徵紀錄安排多輪面試，維護時間、面試官、地點與狀態；每輪可自訂多個 1～5 分評分面向及書面評語。
- 核薪與錄取：期望、建議、核定薪資及薪酬說明只開放 admin；錄取通知可依候選人、職缺與核定薪資產生範本、編輯並一鍵複製。
- 到職文件：HR 可自訂必填／選填項目；每位錄取候選人的 checklist 可逐項勾選、取消與保存備註，必填項完成後才能進入到職。
- 試用期追蹤：到職日加試用天數自動計算到期日，記錄通過／延長／不通過；`settings.probation_reminder_days` 預設 14 天，可調整，提醒同時顯示於招募頁與管理儀表板。
- 招募漏斗 API：同時提供各階段目前人數與歷史進入人數，供目前招募工作台及後續 M4 報表使用；本階段未建立 M4 報表頁。

## Migration 與 seed

- `0001_initial_schema.sql`：33 張業務表，涵蓋規格列出的 M1～M5 完整資料模型。
- `0002_indexes.sql`：查詢索引與 `updated_at` triggers。
- `0003_seed.sql`：15 位員工、3 種職務類型、9 門課、6 場次、封鎖／全員必訓日、2 職缺、4 候選人與到期證照。
- `0004_m2_enrollment_review.sql`：選修報名審核人、時間、備註欄位與待審佇列索引。
- `0005_m3_recruitment.sql`：跨職缺應徵紀錄、狀態歷程、核薪、錄取通知、到職 checklist、試用期關聯與索引。

場次與提醒日期使用 `date('now', '+N day')`，確保每次新環境套 seed 時仍落在未來一個月。

## 設計決定

- 職務級距存為 1～3，課程必修判斷為 `job_type.required_level >= course.competency_level`，未寫死職務名稱。
- 課程刪除採停用（soft archive），場次刪除採取消，以保留歷史與稽核資料。
- 場次指派人數超過名額時阻擋；HR 必須提高名額或縮減名單。
- 選修報名以單一條件式 `INSERT ... SELECT` 同時檢查開放狀態、名額、重複報名與時段衝突。
- 必修完成率以「目前有效的必修課程」對「員工曾完成的 distinct 課程」計算；重訓不重複增加分子。
- 選修報名設定預設直接核准；切為審核制後，新申請先進 `waitlisted`，不先占用正式名額，核准時再檢查容量與衝突。
- 證照到期提醒含「已逾期」與未來 N 天內到期資料；無到期日的永久證照不產生提醒。
- 訓練矩陣只列必修課，紅／黃／綠門檻採 `<50%`、`50–79%`、`≥80%`。
- 候選人主檔作為可重用人才庫；每次應徵另存 `candidate_applications`，避免把候選人永久綁定單一職缺。
- 招募狀態採 forward-only：面試進核薪前須有完成的面試評分、核薪進錄取前須核定薪資、錄取進 hired 前須接受通知、hired 進到職前須完成必填文件。
- 試用期提醒沿用證照提醒的 on-read 計算模式，不新增排程服務；未記錄結果且在提醒區間內或已逾期者持續顯示。
- 日期存 `YYYY-MM-DD`、時間存 `HH:mm`、事件 timestamp 存 ISO 8601 UTC；畫面業務語意一律採 Asia/Taipei。
- `tsconfig.test.json` 僅對 Cloudflare Vitest 第三方宣告檔啟用 `skipLibCheck`，應用端與 Worker 端維持完整 strict typecheck。

## 尚未開始

M4 報表與 M5 人才盤點的功能、路由與頁面尚未開始；需等待下一階段明確確認。

## 授權

本專案採 [MIT License](LICENSE)。

種子資料中的員工姓名、部門與電子郵件皆為虛構的示範資料，與任何真實個人或組織無關。
