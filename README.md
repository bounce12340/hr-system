# HR 學習排課與人資管理系統

Cloudflare Pages 靜態 SPA（Preact + Vite）與 Pages Functions REST API，資料儲存在 Cloudflare D1。全站介面為繁體中文，時區固定為 `Asia/Taipei`。

五個模組（M1 學習排課、M2 教育訓練／證照、M3 招募、M4 報表、M5 人才盤點）連同 Auth／RBAC、員工主檔、出缺勤管理與系統設定皆已完成。各模組的獨立驗收報告見 `ACCEPTANCE-M1.md`～`ACCEPTANCE-M5.md`。

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
- 登入與忘記密碼可加上 Cloudflare Turnstile 人機驗證，擋自動化猜密碼（見下節）。

### 人機驗證（Cloudflare Turnstile）

以兩個環境變數啟用，**兩者必須成對**，只設一項會靜默維持未啟用（管理者可在「系統設定 → 登入保護」看到目前狀態）：

```bash
npx wrangler pages secret put TURNSTILE_SITE_KEY --project-name hr-system
npx wrangler pages secret put TURNSTILE_SECRET_KEY --project-name hr-system
```

本機開發放 `.dev.vars`（已列入 `.gitignore`），可直接用 Cloudflare 的
[測試金鑰](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)：
site key `1x00000000000000000000AA`、secret `1x0000000000000000000000000000000AA`。

改動這一區時要知道的四件事：

1. **驗證在後端 `/api/auth/login` 裡面，不是在前端擋送出。** 前端擋對暴力破解無效——機器人不執行你的 JS，直接 POST 就繞過去了。實作在 `src/server/turnstile.ts`，呼叫點刻意排在 PBKDF2 之前，否則擋得住「猜中」卻擋不住「猜」。
2. **`public/_headers` 的 CSP 必須含 `script-src` 與 `frame-src` 的 `https://challenges.cloudflare.com`。** 漏掉的症狀是全站沒有人能登入，而且本機未設定金鑰時完全不會發現。
3. **登入表單與忘記密碼表單的 `<TurnstileWidget>` 必須有不同的 `key`。** 兩者在 DOM 中型別與位置相同，Preact 會重用同一個元件實例，導致忘記密碼的送出鈕永遠鎖住。
4. **測試環境一律關閉**（`vitest.config.ts` 以空字串覆蓋）。否則本機設了金鑰就會有十幾個測試檔一起垮，且失敗訊息看不出成因。

服務中斷時的緊急處置是移除 secret 退回未啟用——設計上是 fail closed，siteverify 連不上會回 `503` 而非 `403`，用狀態碼即可分辨：

```bash
npx wrangler pages secret delete TURNSTILE_SECRET_KEY --project-name hr-system
```

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
- 招募漏斗 API：同時提供各階段目前人數與歷史進入人數，供招募工作台與 M4 報表共用。

## M4 功能

- 六項指標：在職人數與人力結構（部門、職等分佈）、離職率、缺勤與加班統計、招募漏斗、教育訓練完成率、薪資成本（admin-only）。
- 通用篩選：部門、職等、期間（起迄月份），六張報表共用同一組條件。
- 匯出：每張報表皆可匯出 CSV 與 .xlsx，於前端產生。
- 出缺勤管理：手動 CRUD 與 CSV 匯入兩種資料來源；員工主檔亦支援 CSV 匯入。匯入採逐列回報，部分列失敗不影響其餘列。

## M5 功能

- 職能模型：職位別的職能項目與等級要求，項目可自訂。
- 九宮格：績效 × 潛力 3×3 網格，以下拉選單指定落點。
- 關鍵職位與繼任者：每個關鍵職位可設多位繼任者與準備度（立即／1–2 年／3 年以上）。
- IDP：admin 管理全部計畫與行動項目；員工可於「我的 IDP」檢視並更新自己項目的狀態與備註。

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

### M4 報表

- **離職率＝期間內離職人數 ÷ 平均在職數**，其中「平均在職數」規格未定義，此處採 `(期初在職數 + 期末在職數) / 2`。
- 期間為**起始含、結束不含**；在職與否以 `hire_date`／`termination_date` 判定，而非 `status` 欄位，離職當日不計入在職。
- 薪資成本只加總期末在職者。
- 教育訓練完成率採期末「截至」語意。
- 篩選維度的三個例外：招募漏斗不支援職等篩選（應徵者尚非員工，無職等）；漏斗期間以 `applied_at` 為準；完成率只吃結束月份。
- 出缺勤一律取自 `attendance` 表。專案另有 `enrollments.attendance_status`，那是 M1 訓練場次簽到，語意不同，兩者不可混用。
- `.xlsx` 為自行產生而非使用規格建議的 SheetJS，理由見 `src/client/export.ts` 檔頭。

### M5 人才盤點

- 繼任者準備度的欄位值為 `ready_now`／`one_two_years`／`three_plus_years`（欄位值不可以數字開頭）；中文標籤由後端統一回傳，前端不自建對照表。
- 九宮格落點以下拉選單指定而非拖放：拖放在觸控裝置不可用，而規格要求手機可正常操作。
- 員工端 IDP 的可寫欄位僅 `status` 與 `employee_notes`，限制寫在 SQL 語句本身。

### 員工個人資料

- 員工可自行修改的欄位僅姓名與聯絡信箱（`employees.email`，與登入帳號 `users.email` 分離）；HR 掌控欄位的防護同樣寫在 SQL 語句，請求夾帶亦無效。

## 授權

本專案採 [MIT License](LICENSE)。

種子資料中的員工姓名、部門與電子郵件皆為虛構的示範資料，與任何真實個人或組織無關。
