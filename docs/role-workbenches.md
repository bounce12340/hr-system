# 角色工作台（HR/admin 與 employee）最小驗收

基底：worktree `/var/minis/workspace/hr-role-workbenches`，branch `feat/role-workbenches`，HEAD `2045e79c8dea454bd3d19807bd61db0d24706a5f`。主 repo `/var/minis/workspace/hr-system` 的 dirty `docs/completion-round-2.md` 不碰、不 merge、不 cherry-pick。

這份文件先記錄實作前現況（file:line），再列最小驗收。日期分組是工作台呈現規則，不是新的訓練、到職或重訓政策。

## 現況（實作前）

| 項目 | 證據 | 缺口 |
| --- | --- | --- |
| Admin 儀表板 | `src/client/pages/M2AdminPages.tsx:24` `AdminDashboard` 讀 `/api/admin/dashboard`；handler `src/server/m2.ts:227` | 只有證照／試用期／健檢／待審／補訓／必修計數，沒有工作台列 |
| Employee 首頁 | `src/client/pages/M2EmployeePages.tsx:13` `EmployeeHome` 讀 `/api/employee/home`；handler `src/server/m2.ts:868` | 只有近期場次數、必修、證照提醒，沒有工作台列 |
| 路由閘門 | `src/server/router.ts` admin 路徑先 `requireAdmin`；employee 路徑進各模組後 `requireEmployeeIdentity`（`src/server/http.ts:76`、`:87`） | 工作台若新開端點，必須沿用同一閘門，不可接受 query `employeeId` |
| 導航 | admin tab：`src/client/pages/AdminApp.tsx:40`；recruitment 次分頁含 `onboarding`：`src/client/pages/M3AdminPages.tsx:5`、`:117`；排課次分頁 `attendance`：`AdminApp.tsx` `SchedulingSection`；證照在 `M6AdminPages.tsx:35` `certifications`。employee tab：`EmployeeApp.tsx:11` `schedule`／`certifications` | 沒有從首頁列點進這些既有頁的連結 |
| 到職缺件 | checklist 查詢 `src/server/m3.ts:1054` `onboardingChecklist`；轉員工前必填未完成阻擋 `src/server/onboarding-conversion.ts:124`。表 `application_onboarding_checklist`（`migrations/0005_m3_recruitment.sql:116`）只有 `completed`／`completed_at`／`notes`，沒有 due date。狀態 `hired`／`onboarded` 在 `candidate_applications.status` | 沒有「hired/onboarded 且必填未完成」的彙總列。不可自訂到職截止日 |
| 課程場次 | `course_sessions.session_date`＋`status`（`migrations/0001_initial_schema.sql:82`）；`enrollments.enrollment_status`／`attendance_status`（`:111`）。employee 近期計數只算 `enrolled`＋`scheduled`＋`session_date >= date('now')`（`m2.ts:878`） | 沒有「已過、待核對」列。不可把歷史課或 `valid_until` 當成缺席／逾期 |
| 證照 | `employee_certifications.expires_at` 可為 NULL（`:168`）；提醒窗用 `date('now')` 與 `certification_reminder_days`（`m2.ts:201`） | 工作台要改用 Asia/Taipei 的 today，且 NULL＝永久、不逾期。不改 `valid_until` 完訓計算（`m2.ts` `mandatoryTraining`） |

## 範圍

做：

- 首頁保留既有 summary，另加工作台區。
- 只列三種來源：admin 到職缺件；admin 既有可見場次與 employee 自己已報名／指派場次；既有 `expires_at` 證照。
- 小的唯讀端點與純函式分類。不重做 dashboard、不改 schema、不做 mutation、不寫通知 outbox。

不做：健檢、試用期、通知、主管視角、帳號自動化、強制重訓、自訂到職截止日、任意 URL。

## 日期規則（呈現，非政策）

- 時區 Asia/Taipei。today＝該時區日曆日 `YYYY-MM-DD`。
- 本週＝含 today 的週一至週日（週一為一週第一天）。UI 必須寫出起迄日期。
- `dueDate === today` → 今天，不是逾期。
- `today <= dueDate <= 本週日` 且不是今天 → 本週。
- 分組可在語意上重疊（今天也在本週內），UI 以今天／本週／逾期／未設定期限分組，一列只出現一次。
- 逾期僅限既有明確日期 `< today`。
- 證照 `expires_at` 為 NULL → 永久，不進工作台。非 `YYYY-MM-DD` → `dueDate: null`，分組「未設定期限／待補資料」，不排除、不說全部正常。
- 到職 checklist 沒有 due date → `dueDate: null`，同樣放未設定期限。不發明截止日，因此也不會被判逾期。
- 課程只列 `course_sessions.status = 'scheduled'` 且 `enrollments.enrollment_status = 'enrolled'`。已取消報名、已取消場次、已完成場次不列。
- 過去場次不是自動逾期、也不假設缺席。`session_date < today` 的列分組為「場次已過、待核對」，`reason` 寫明待核對而非缺席。`dueDate` 仍是場次日，方便對照，但不算證照式逾期。
- `training_records.valid_until` 不參與本工作台，也不改變既有完訓計算。

## 列與來源狀態

每列：穩定 `id`、`source`（`onboarding_missing`｜`course_session`｜`certification_expiry`）、`title`、`reason`、`dueDate`（`YYYY-MM-DD` 或 `null`）、`bucket`、`nextAction`、`target`。

`target` 只允許既有頁：

- admin：`recruitment/onboarding`、`scheduling/attendance`、`health/certifications`
- employee：`schedule`、`certifications`

前端只依這個 allowlist 切既有 tab（recruitment／health／scheduling 會再切次分頁）。不接收任意 URL，不用 `dangerouslySetInnerHTML`。

來源狀態：`ok`｜`insufficient`｜`error`。`insufficient` 表示該來源有列但日期無法分類，或查詢成功但資料不足以排程；不得把這類列悄悄丟掉後宣稱沒有待辦。整支 API 失敗才是 `error`，UI 顯示載入失敗與重試，不可把 catch 變成空陣列成功。空的 `ok` 來源顯示「無待辦」。request 序號避免舊回應覆蓋新結果。

Employee 端點只用 session `employeeId`，SQL `employee_id = ?`。不讀 query `employeeId`。不回候選人、薪資、其他員工。Admin 端點沿用既有 `requireAdmin`，employee 呼叫得 403，匿名 401。

## 驗收案例

1. 固定 now：台北 UTC 跨日（UTC 16:30 仍是台北當日；UTC 15:30 已是台北次日）與週界（週日、跨週一）。
2. 證照：到期＝today 進今天；昨天進逾期；本週日進本週；NULL 不出現；非法日期進未設定期限且 `sources.certification_expiry = insufficient`。
3. 到職：`hired`／`onboarded` 且必填未完成進未設定期限，`dueDate null`，不逾期。已完成必填、非必填未完成、`applied` 不進列。
4. 場次：自己的 `enrolled`＋`scheduled` 進今天／本週／更晚／已過待核對。`cancelled` 報名、`cancelled` 場次、`completed` 場次不進列。employee A 看不到 B，也看不到 admin 到職缺件。
5. 匿名 401；employee 打 admin 工作台 403；admin 打 employee 工作台 403（無 employeeId）。
6. UI／formatter：空集合＝無待辦；缺日期＝資料不足；error＝載入失敗＋重試，不是空白成功。

## 實作後驗證（2026-09-29，本機）

| 命令 | exit | 等級 |
| --- | --- | --- |
| `node scripts/workbench-sqlite-probe.mjs` | 0 | Node `sqlite` 套用 migrations 後跑來源 SQL，加上 probe 內的日期／文案複本。不是 Vitest，也沒有直接 import `src/shared/workbench.ts`。 |
| `node node_modules/typescript/lib/tsc.js -p tsconfig.worker.json --noEmit`（於 `/tmp/hr-copy`，`node_modules` symlink 到主 repo，未改來源） | 0 | 正式 `tsc`，只覆蓋 worker config。 |
| `tsc -p tsconfig.client.json`、`tsconfig.test.json`、`tsconfig.tools.json` | 未完成 | client 兩次 120／180 秒無診斷輸出後逾時；後兩者未跑。不視為通過。 |
| `vitest run test/role-workbench.test.ts` | 1 | 既有 `vite/dist/node/module-runner.js` ENOENT。不是本任務斷言失敗，也不能用舊 CI 代替。 |

`M6AdminPages.tsx` 只加 `initialSection`，預設仍是 `due`。健檢名單、紀錄與政策都沒改。tsconfig 只把 `src/shared`（test 另含 `src/client` 以便 SSR）納入既有 include，沒有降 `strict`、沒有 skip。

