# 資料品質待補清單

## 範圍

管理端唯讀 `GET /api/admin/data-quality`。沿用 `/api/admin/` 的 `requireAdmin`：未登入 401、非 admin 403。只列出既有規則無法計算的缺口，不發明補值、不把缺資料標成 overdue。`dueDate` 一律 `null`。

回應為 `{ counts, items }`。空 `items` 表示目前沒有待補，不是錯誤。查詢失敗走既有 `errorResponse`；前端獨立載入此端點，失敗顯示可重試錯誤，不把失敗渲染成空清單。

每筆含 stable `id`、`entityType`、`entityId`、`field`、`reason`、`impact`、`nextAction.tab`、`dueDate`。`nextAction` 只指向既有管理分頁 id（`employees` 或 `settings`），沒有外部 URL。

UI 在管理儀表板增加「資料待補」：載入中、失敗可重試、無待補、有清單。不顯示薪資、健檢結果或診斷。僅 admin 殼層可進入。

## 列入的缺口

1. `employees.birth_date` 為 NULL 或只有空白：沿用 `health.ts` 的 `missing_birth_date`。沒有生日就無法依年齡級距計算健檢頻率。不重寫健檢計算。
2. `employees.department` 只有空白：報表以部門等值篩選，空白無法歸入任何部門。schema 是 `TEXT NOT NULL`，所以 NULL 不是可寫入狀態；空白仍可能由直接 SQL 寫入，因此只列空白。
3. `users.employee_id IS NULL AND archived_at IS NULL`：帳號未連結員工。員工端 `requireEmployeeIdentity` 會 403。封存列不列。不建議依 email 自動綁定，也不在此建立帳號。

## 不列入、也不假造

- `job_type_id`：`employees.job_type_id TEXT NOT NULL REFERENCES job_types(id)`。寫入路徑還會確認職務類型存在。SQLite 預設不強制既有列的外鍵，但此端點沒有可修復的「欄位空」路徑；停用中的職務類型仍能 JOIN 出 `required_level`，必修課查詢（`m2.ts` mandatory training）沒有要求 `jt.active = 1`，因此停用不是「算不出必修課」。不把停用或假設中的懸空 FK 列成缺口。
- `hire_date`：`employees.hire_date TEXT NOT NULL`。建立／更新走 `isoDate`，到職轉換走 `strictIsoDate`，空字串與 NULL 都不能經這些路徑寫入。非法日期若已在庫內，現有在職判斷仍是字串比較，不是本端點要補的值；因為欄位不允許空值，本清單不另造 hire_date 缺口。非法日期的拒絕仍由既有 `strictIsoDate` 負責，見 `test/completion-round-2.test.ts`。

## 不做事項

不改 schema、不寫入、不通知、不建帳號、不依 email 自動綁定、不改工作台分支、不把缺資料標成 overdue、不顯示薪資或健檢結果／診斷。非 GET 回 405。

## 驗證等級

- 回歸測試：`test/data-quality.test.ts`。預期覆蓋缺生日、空白部門、未連結帳號、正常員工不出現、封存帳號不出現、員工 token 403、未登入 401、`dueDate: null`，以及既有 `strictIsoDate` 拒絕空字串與 `2026-02-30`。
- 本文件不宣稱 Vitest、CI 或瀏覽器通過。實際執行結果以該次 commit 回報為準。
- 若 Vitest 因 `module-runner.js` realpath ENOENT 無法載入設定，該項記為未跑。隔離 SQLite 探針 `scripts/verify-data-quality-sqlite.py` 只驗證來源 SQL 與 schema 的 NOT NULL 保證，不是 Vitest、不是 D1、不是 staging。
