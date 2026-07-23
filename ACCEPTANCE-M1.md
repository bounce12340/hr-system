# HR 系統 M1 交付範圍驗收報告

驗收對象：D:\hr-system（開發順序第 1～3 步：repo scaffold＋wrangler＋D1 migration/seed、Auth＋RBAC、M1 學習排課）
驗收日期：2026-07-23
驗收方式：實際執行指令、實際打 API（非純讀 code）

---

## 一、程式碼類驗證

### 1. `npm run typecheck`
**PASS**。`tsc -p tsconfig.client.json / tsconfig.worker.json / tsconfig.test.json / tsconfig.tools.json --noEmit` 全部通過，無錯誤輸出。

### 2. `npm test`
**PASS**。`vitest run` → 2 個測試檔（`test/auth.test.ts`、`test/m1.test.ts`），共 10 個測試全數通過，耗時 2.74s。

### 3. `npm run build`
**PASS**。`vite build` 成功產出 `dist/index.html`、`dist/assets/index-*.css`（14.13 kB）、`dist/assets/index-*.js`（44.18 kB），無錯誤。

### 4. Migration 與 seed 資料
**PASS**。

- `npx wrangler d1 migrations list DB --local` → `✅ No migrations to apply!`（`0001_initial_schema.sql`、`0002_indexes.sql`、`0003_seed.sql` 三個 migration 全部套用）。
- 資料表：`sqlite_master` 查詢確認 33 張業務表（不含 `sqlite_%`/`_cf_%`/`d1_migrations`），涵蓋規格第六節列出的全部資料表：`users`、`employees`、`job_types`、`courses`、`course_sessions`、`enrollments`、`special_days`、`tests`/`test_results`、`certifications`/`employee_certifications`、`attendance`、`job_openings`、`candidates`、`interviews`/`interview_scores`、`offers`、`onboarding_items`/`onboarding_checklist`、`probations`、`competency_models`、`nine_grid`、`key_positions`/`successors`、`idp_plans`/`idp_items`、`settings`，另有 `sessions`、`training_records`、`audit_logs`、`conflict_overrides`、`candidate_status_history` 等支援表。
- Seed 數量（實查 SQL）：`employees`=15（3 部門各 5 人、3 種職務類型各 5 人，累進級距 1/2/3 正確）、`courses`=9（等級 1/2/3 皆有，含必修 7 門＋選修 2 門）、`course_sessions`=6、`special_days`：`blackout`=1（`sd-blackout`，2026-08-07）、`mandatory_all`=1（`sd-all`，2026-08-18）、`job_openings`=2、`candidates`=4、`employee_certifications`=3（其中 `ec-01` 剩餘 24.66 天到期，符合「30 天內到期」要求）。全部數字落在規格第八節區間內。

### 5. 啟動 dev server 並實測驗收清單第 1～6 項

啟動方式：`npx wrangler pages dev dist --port 8788`（背景執行，等待就緒後測試，結束後已 `taskkill` 關閉，確認 port 8788 監聽已釋放）。

先以 `POST /api/auth/login`（`admin@demo.local` / `Demo1234!`）取得 session cookie；因 seed 帳號皆強制 `mustChangePassword=true`，先以 `POST /api/auth/change-password` 完成首次改密才能繼續打其餘 admin API（此行為本身即驗證了首次登入強制改密碼，見下方項 5）。

**項 1（中級必修課應上名單＝診所線＋醫院線，內勤不在名單）：PASS**
建立課程「驗收用中級必修課」（`competencyLevel=2, courseType=mandatory`），呼叫 `POST /api/admin/course-sessions/assignment-preview`：
- `jobType=內勤`（requiredLevel=1）15 人中 5 人全部 `recommended:false`
- `jobType=診所線`（requiredLevel=2）5 人全部 `recommended:true`
- `jobType=醫院線`（requiredLevel=3）5 人全部 `recommended:true`
正式建立場次（`POST /api/admin/course-sessions`）回傳 `assignedCount:10`（5+5，內勤 5 人未列入），與邏輯一致。
證據：`src/server/m1.ts:212-224`（`recommendedEmployeeIds`：`employee.requiredLevel >= course.competencyLevel`）。

**項 2（封鎖日排場次被阻擋且有繁中錯誤訊息）：PASS**
在封鎖日 2026-08-07（`sd-blackout`）呼叫 `POST /api/admin/course-sessions` → `HTTP 422`：
`{"message":"此日為封鎖日「全公司年度盤點」：全員支援年度盤點，禁止排課。"}`
證據：`src/server/m1.ts:283-285`。

**項 3（全員必訓日建場次→全體在職員工進應到名單）：PASS**
在 `sd-all`（2026-08-18，`mandatory_all`）建立場次，`POST /api/admin/course-sessions` 回傳 `assignedCount:15`（在職員工全數 15 人，含內勤），`assignment-preview` 亦顯示 15 位員工 `recommended:true`，0 位 `false`。
證據：`src/server/m1.ts:217`（`if (specialDay?.dayType === "mandatory_all") return new Set(employees...)`）。

**項 4（同員工同時段兩場次出現衝突警告）：PASS**
員工 emp-002（林家豪）已在 2026-08-25 09:00–12:00 有場次，對同日 10:00–13:00 另一課程指派同一員工 → `HTTP 409`：
`{"message":"指派名單有時段衝突，請調整名單或確認強制覆寫。","details":{"conflicts":[{"employeeId":"emp-002",...,"conflictingSessionId":"84e8fc7a-...","sessionDate":"2026-08-25","startTime":"09:00","endTime":"12:00"}]}}`
證據：`src/server/m1.ts:524-533`（衝突偵測＋409／可強制覆寫但需填原因，`m1.ts:534-536`）。

**項 5（employee 打 admin-only API 必須 403；查他人資料被擋；首次登入強制改密碼）：PASS**
- 首次登入：`employee` 帳號登入回應 `mustChangePassword:true`；在改密碼前呼叫任何需登入的 API（含自己的 `/api/employee/schedule`）一律回 `HTTP 428 {"message":"首次登入請先變更密碼。"}`，並非放行後才擋，符合「強制」語意。證據：`src/server/http.ts:76-96`（`requireAdmin`/`requireEmployeeIdentity` 皆先檢查 `mustChangePassword`）。
- 完成改密碼（`POST /api/auth/change-password`）後，用該 employee token 呼叫 `GET /api/admin/employees` 與 `POST /api/admin/courses` → 均為 `HTTP 403 {"message":"您沒有執行此操作的權限。"}`。
- 查他人資料：M1 的 employee 端 API（`/api/employee/schedule`、`/api/employee/training-records` 等）皆以 session 內的 `user.employeeId` 決定資料範圍，不接受前端傳入 ID；實測在 URL 附加 `?employeeId=emp-001` 查詢紀錄，回傳的仍是自己（emp-002）的資料，證明無法藉參數竄改查得他人資料。證據：`src/server/m1.ts:1049-1068`（`handleEmployeeM1` 所有查詢皆用 `user.employeeId`，未讀取 query/body 中的 employeeId）。

**項 6（出席標記完成→完訓率 API 數字更新）：PASS**
場次 `cs-01`（seed 課程，因 seed 用 `date('now','+N day')` 動態產生皆為未來日期，實測前先以 SQL 將 `cs-01.session_date` 改為過去日 2026-07-20 以符合「場次已結束才能登錄出席」的業務規則——此為測試環境調整，非程式邏輯瑕疵）。
- 標記前：`GET /api/admin/completion` 中 emp-002 `completedCount:0, completionRate:0`（requiredCount:7）。
- 呼叫 `PUT /api/admin/course-sessions/cs-01/attendance`，`{"records":[{"employeeId":"emp-002","status":"completed"}]}` → 200。
- 標記後：admin 端與 employee 端（`GET /api/employee/training-records`）皆顯示 `completedCount:1, completionRate:14`（1/7 四捨五入）。
證據：`src/server/m1.ts:711-784`（`recordAttendance` 寫入 `training_records`）、`src/server/m1.ts:801-844`（`completionData` 即時重算完成率）。

補充說明：測試過程中因 Bash 工具經由 shell 傳遞含中文字元的 `-d` 參數時遇到編碼損壞（`curl -d '...中文...'` 在此 Windows/Git Bash 環境下中文變亂碼），改用 `--data-binary @file` 方式後確認 API 與資料庫皆正確存取 UTF-8 中文，證實是測試工具層的編碼問題，非應用程式 bug；但過程中留下一筆亂碼課程資料（id 82337f45-...）在本機測試用 D1，屬本次驗收操作產生的測試污染，不影響驗收判定，也不會出現在乾淨環境（因為只存在於本機 `.wrangler/state`，非 migration/seed 內容）。

### 6. 響應式設計（規格項 10）
**部分驗證（未實機操作）**。僅讀 code，未用瀏覽器在 375px 寬度實際操作。
- `index.html:5` 有 `<meta name="viewport" content="width=device-width, initial-scale=1.0" />`。
- `src/client/styles.css:191-200`（`@media (max-width: 900px)`）：側欄隱藏、改用 `mobile-header`，月曆/出席等版面改單欄。
- `src/client/styles.css:202-224+`（`@media (max-width: 600px)`）：登入頁單欄、表單改單欄、月曆格高度與事件標籤縮小、`special-day-card`／`employee-header` 皆有手機版調整。
結論：程式碼層面確有因應手機寬度的版面規則，但未實際用瀏覽器/裝置在 375px 寬度操作驗證互動是否可用，故列為部分驗證。

---

## 二、檔案類驗證

### README 部署步驟
**PASS**。`README.md:39-65` 完整涵蓋：`wrangler login` → `wrangler d1 create` → 寫入 `database_id` → `wrangler:types` → `wrangler d1 migrations apply DB --remote` → `wrangler pages project create` → `npm run deploy` → Dashboard 綁定自訂網域 `hr.example.com`。另有本機開發（`README.md:9-18`）、Demo 帳號（`README.md:20-26`）、設計決定（`README.md:94-102`）、尚未開始事項（`README.md:104-106`，明確列出 M2～M5 功能未開始）等章節，誠實揭露交付範圍。

### Migration 檔完整性
**PASS**。`migrations/0001_initial_schema.sql`（349 行，33 張表）、`migrations/0002_indexes.sql`（47 行，索引與 `updated_at` trigger）、`migrations/0003_seed.sql`（109 行，seed 資料）。資料表清單已於上方「一之4」核對涵蓋規格第六節全部項目。

### wrangler 設定
**PASS**。`wrangler.jsonc` 存在，含 `pages_build_output_dir`、`d1_databases`（binding `DB`，`migrations_dir: ./migrations`）、`observability` 設定；`database_id` 為全零 placeholder（README 已註明部署時需替換為真實值，屬合理預設）。

---

## 三、逐條結論彙總

| 項目 | 結果 |
|---|---|
| npm run typecheck | PASS |
| npm test（10/10） | PASS |
| npm run build | PASS |
| migration 全套用（3 個檔） | PASS |
| 資料表涵蓋規格第六節 | PASS |
| Seed 數量／內容符合規格第八節 | PASS |
| 驗收項 1：中級課應上名單 | PASS |
| 驗收項 2：封鎖日阻擋＋繁中訊息 | PASS |
| 驗收項 3：全員必訓日全員應到 | PASS |
| 驗收項 4：同員工同時段衝突警告 | PASS |
| 驗收項 5：employee 403／查他人資料被擋／強制改密碼 | PASS |
| 驗收項 6：出席完成→完訓率更新 | PASS |
| 驗收項 10：響應式（手機寬度） | 部分驗證（未實機操作，僅 code review 確認有 media query 與 viewport） |
| README 部署步驟 | PASS |
| Migration 檔完整性 | PASS |
| wrangler 設定存在 | PASS |

## 四、實際檢查範圍說明

- 執行 `npm run typecheck`、`npm test`、`npm run build`，皆為實際指令執行並讀取完整輸出。
- 用 `npx wrangler d1 migrations list/execute --local` 直接查詢本機 D1 SQLite 檔案內容（非只讀 SQL 檔案），確認 33 張表、員工/課程/場次/重要日子/證照/候選人等實際列數與欄位值。
- 啟動 `npx wrangler pages dev dist --port 8788`，用 `curl` 對 REST API 送出真實 HTTP 請求（含登入、改密碼、建課程、建場次、assignment-preview、衝突建場次、出席登錄、admin-only 403 測試、他人資料查詢阻擋測試），逐一比對 HTTP 狀態碼與回應 JSON 內容，而非只讀原始碼推測行為。測試後已用 `taskkill` 關閉該 dev server 行程，並用 `netstat` 確認 port 8788 已釋放。
- 讀了 `src/server/router.ts`、`src/server/http.ts`、`src/server/auth.ts`、`src/server/m1.ts` 全文以定位每條驗收證據的檔案與行號。
- 響應式僅讀 `index.html`、`src/client/styles.css` 的 media query，未用瀏覽器/裝置模擬器實際操作驗證，故該項標記「部分驗證」。
- 未測試 M2～M5 的任何功能性 API（規格與任務範圍本就不要求，只驗證資料表存在，已於「資料表涵蓋規格第六節」項確認）。
- 未測試遠端（`--remote`）部署流程（建立正式 D1、Pages 專案、自訂網域綁定），僅檢查 README 步驟是否完整合理，未實際跑 `wrangler d1 create`／`wrangler pages deploy` 對真實 Cloudflare 帳號操作。

## 五、發現的問題

無 FAIL 項目。過程中唯一的異常（`82337f45-...` 課程名稱亂碼）已查明為本地 Bash/Git Bash 傳遞中文參數給 curl `-d` 時的 shell 層編碼問題，改用檔案方式送出後確認 API／資料庫皆正確處理 UTF-8，非應用程式缺陷；該筆測試髒資料僅存在本機 `.wrangler/state`，不影響 migration/seed 本身。
