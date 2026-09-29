# 第二輪本機補完紀錄

## 範圍與授權

- 工作樹：`/var/minis/workspace/hr-system`；分支 `improve/completion-round-2`；接手基準 HEAD `595bc86b4e0704db0110fc2d2a2d56296b21aea5`。接手時已存在未提交草稿，已逐檔審查後以最小修正保留並完成，沒有 reset、clean、stash 或覆蓋他人變更。
- 本輪僅本機程式、隔離 SQLite 與靜態驗證。**未** push、PR、merge、deploy、遠端 D1 操作、讀取正式資料/secret、寄送真實信件或啟用任何排程。
- 完成到職轉員工主檔與「通知 outbox 的安全準備」；不是通知正式上線。

## 完成實作

### 到職轉員工

- 新增管理員專用 `POST /api/admin/recruitment/applications/:id/convert-employee`。全域 `/api/admin/` 授權閘門及 M3 的 `requireAdmin` 均會執行；一般員工不可使用。
- 要求 `confirmed: true` 及明確填寫員編、候選人同一 Email、部門、職等、職務、啟用中的職務類型與到職日；薪資可由 HR 明確留空。前端提供核對表單，不預設職等或薪資。
- 新的 hired 到職只能走顯式 `confirmed` 轉換。舊 `POST /transition` 若目標是 `onboarded`，直接回 409 並指引使用確認到職；前端不再提供「進入到職」。`hired → rejected` 仍保留。
- 既有 `onboarded` 且沒有 conversion 的資料，可由同一端點經 HR 明確確認補建。狀態已是 `onboarded` 時不再新增 `hired → onboarded` 歷程、不改原到職歷程，audit 以 `legacyBackfill` 標記。仍完整檢查必填文件、職務類型、Email 與員編/Email 唯一性，不會依同 Email 自動綁定既有員工或建立帳號。
- 新轉換與補建都要求必填到職文件已完成、職務類型仍啟用、候選人 Email 一致、且員編/Email 未被使用。在同一個條件式 D1 batch 中重複檢查這些可變前置條件；任一前置條件失效時不建立員工。到職日使用 UTC 日曆 round-trip，拒絕 `2026-02-30` 這類溢位日期。
- `recruitment_employee_conversions.application_id` 主鍵與 `employee_id` 唯一鍵，保證每個應徵最多一筆轉換。相同 payload 的重送回傳同一員工及 `alreadyConverted: true`，不再新增歷程/audit；不同 payload 回 409。併發成功者可被後續相同請求辨識為冪等成功，其他情形安全回 409，不揭露其他員工資料。
- 不建立 `users` 帳號，也不依同 Email 自動綁定任何既有帳號。沒有新增「90 天試用期」或其他新政策；既有試用期設定/流程完全保留。
- 前端在開啟確認表單前檢查必填到職文件，尚未完成則不提交；後端仍是最終且原子化的權威檢查。

### 通知 outbox（嚴格 disabled）

- 新增 `notification_outbox` 表與 `dedup_key` 唯一鍵、claim/retry/unknown 相關欄位，作為**尚未啟用的未來介面**。唯一鍵只保障單一 outbox intent，不代表 exactly-once delivery。
- 移除草稿中未獲確認的「唯一 HR 收件人」設定、設定 API 寫入、outbox claim、寄信與 retry 邏輯。沒有匿名 dispatch API；目前也沒有任何 dispatch API。
- 僅保留管理員可呼叫的 `POST /api/admin/reminder-notifications/run`，且強制接受 `dryRun: true`；它只回傳 count-only 摘要，**不寫入 outbox、不 claim、不呼叫 mailer、不寄信**。`dryRun: false` 固定 409。
- 設定查詢固定回 `enabled: false`、`deliveryAvailable: false`、`policyPending: true`。Pages 專案沒有新增 cron，也沒有宣稱現有排程可用。
- 摘要不含姓名、Email、員編、薪資、證照名稱、健檢結果/診斷、備註或其他敏感內容。

## Migration 順序與部署閘門

`0015_onboarding_notifications.sql` 必須在部署引用轉換/通知程式前套用；它建立 `recruitment_employee_conversions`、`notification_outbox` 與 outbox 索引，未寫入任何收件者、派送開關或資料。

本機 SQLite 可套用不代表 D1 可直接套用。正式前仍需依變更管控：備份/還原演練、staging 套用與驗證、確認目前 D1 schema 已成功執行 0001–0014，再套 0015，最後部署相容程式；本輪未執行上述動作。

## 尚待確認的產品/資安決策（維持 disabled）

1. 通知事件、收件人/群組、授權角色、內容/語言、個資最小化、保留期限與撤回規則。
2. 排程來源、執行身分、失敗告警、lease/claim 逾時復原、速率限制及監控成本。
3. 供應商 acknowledgement 逾時或未知送達時的人工覆核程序。不得盲目重試，亦不得宣稱 exactly-once。
4. 是否要在到職轉換後建立帳號/發送邀請；目前刻意不做，須另行核准並設計帳號生命週期與身分驗證。

## 基底驗證證據（`df8bc3e`，保留，不視為本修復通過）

獨立審查在 `df8bc3e2df33f36f5c2130feb0f32cafb1210ab8` 實跑：`tsconfig.test.json` exit 2（`test/completion-round-2.test.ts:63` TS6133，`repeat` 未使用）；client/worker/tools 通過；兩支既有 SQLite 探針通過；Vitest 在載入設定前因 `module-runner.js` realpath ENOENT 失敗。本節先前寫四組 tsc 都通過，與該次審查不符，以下方修復後實跑為準。

## 修復後本機驗證證據

`429637a5b39559e570f5d2f300eecd611e87bc59` 曾把下列四組 typecheck 記為本工作樹實跑 exit 0。後續獨立複查未能在本環境複現成功結束碼，該宣稱**不能**當通過證據，保留為當時紀錄、不採認：

- `node node_modules/typescript/bin/tsc -p tsconfig.client.json --noEmit`
- `node node_modules/typescript/bin/tsc -p tsconfig.worker.json --noEmit`
- `node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit`
- `node node_modules/typescript/bin/tsc -p tsconfig.tools.json --noEmit`

同一 commit 的本機探針紀錄（隔離 SQLite，不是 D1 或 Vitest）：

- `python3 scripts/verify-consistency-sqlite.py`：當時 5 項既有探針通過。
- `python3 scripts/verify-completion-round-2-sqlite.py`：當時 7 項通過，含 legacy onboarded 補建不新增假歷程、員編/Email 占用阻擋。
- `python3 scripts/verify-completion-round-2-fix-sqlite.py`：當時 2 項通過。它複製 hired 正常路徑 SQL，**沒有**覆蓋下方稽核缺陷。
- `git diff --check`：當時通過。
- Node 同等 UTC round-trip 腳本拒絕 `2026-02-30`、`2026-02-31`、`2026-04-31`、`2023-02-29`，接受 `2024-02-29`。這不是直接執行 TS 函式。

回歸測試在該 commit 已有真斷言：相同 payload 重送 200、同一 `employeeId`、`alreadyConverted: true`、員工/history/audit 不變；舊 transition 到職 409；legacy 補建；獨立的不存在申請、非 hired、缺文件、角色 403/未登入 401；預讀後 `batch` 前注入 D1 寫入的競態。那些案例尚未被 Vitest 執行。競態 proxy 只在 `batch` 被呼叫時注入，當時沒有「只改 status、員工 INSERT 仍成功」的分支。

### `429637a` 稽核缺陷（已在後續本機 commit 修正，不是該 SHA 已通過）

`429637a` 在 `db.batch` 前讀 `candidate_applications.status`，把 `legacyBackfill` 綁進 audit `details` 與 201。員工 INSERT 接受 `hired` 或 `onboarded`，所以預讀與 batch 真狀態可以不一致：

- 預讀 `hired`、batch 時已是 `onboarded`：員工與 conversion 仍建立，history 與 status UPDATE 為 0 列，audit 卻寫成一般轉換，201 也回 `legacyBackfill: false`。
- 預讀 `onboarded`、batch 時已是 `hired`：五句都成功且 history 是真的 `hired → onboarded`，audit 與 201 卻標 `legacyBackfill: true`。

後續修正刪除 batch 外的 status 讀取。audit details 在 batch 最後一句用 `EXISTS (SELECT 1 FROM candidate_application_status_history WHERE id = 本次唯一 historyId)` 的 `CASE` 決定 standard 或 legacy。201 的 `legacyBackfill` 只在員工 INSERT 成功時由 `results[2].meta.changes === 0` 決定。相同 payload 重送與競態冪等成功改讀既有 `onboarding.convert` audit，不再硬回 `false`；前端仍用該旗標區分補建訊息。這不是 D1 runtime 實證。

### 稽核修正後本機驗證（不是 D1、不是 Vitest）

本次修正工作樹實跑，四組皆 exit 0，日誌只有 `disabling flag --expose_wasm` warning，沒有 error：

- `node node_modules/typescript/bin/tsc -p tsconfig.client.json --noEmit`：exit 0，約 17:10:05–17:13:07。
- `node node_modules/typescript/bin/tsc -p tsconfig.worker.json --noEmit`：exit 0，約 17:13:07–17:16:10。
- `node node_modules/typescript/bin/tsc -p tsconfig.tools.json --noEmit`：第一次同迴圈在 480 秒總時限被截斷，只有 warning、無結束碼，**該次不採認**。分開重跑 exit 0，約 17:18:16–17:20:04。
- `node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit`：第一次未啟動。分開重跑 exit 0，約 17:20:04–17:22:10。

同次另跑：`python3 scripts/verify-completion-round-2-fix-sqlite.py` 4 項 exit 0；`python3 scripts/verify-completion-round-2-sqlite.py` 7 項 exit 0；`python3 scripts/verify-consistency-sqlite.py` 5 項 exit 0；`git diff --check` exit 0。fix 探針的 SQL 由 `onboarding-conversion.ts` 的 batch 原文擷取，含 hired 正常、batch 前 `hired → onboarded`、batch 前 `onboarded → hired`。這只證明隔離 SQLite 依序可見時 CASE 與列數符合預期，**不是** Cloudflare D1 batch，也**不是** Vitest。新增的兩支回歸案例尚未執行。

在 CI run `36556876980` 兩個 Node job 各 245 pass、1 fail，失敗定位為測試 fixture：相同 payload 競態注入的員編 `RACE-EMP` 與 request body 員編不同，並非產品 `sameConversion` 冪等邏輯缺陷；一般 email 佔用案例原先候選人 email 也未與 request 一致，未形成唯一衝突條件。本輪修復將注入資料的比對欄位綁定 body，讓 email 佔用案例建立同候選人 email（大小寫差異），並把 same/different/conflict race 拆成獨立 `it`，保留原有 200/409、alreadyConverted、same employeeId 與 no-extra counts 斷言。此段為測試 fixture 修復來源，不將 source inspection 當 Vitest 證據。

- `429637a` 再執行一次 `node node_modules/vitest/vitest.mjs run test/completion-round-2.test.ts` 為 exit 1。`node_modules/.bin/vitest` 不存在；既有 `vitest.mjs` 在載入設定前失敗：`module-runner.js` 檔案存在，但 Vite `realpath` 回 ENOENT。輸出在 `/tmp/vitest-r2-fix.out`。未安裝套件、未改 lockfile、未降低 strict。Vitest 測試本體未執行，不得標通過。後續稽核修正**不重跑** Vitest。
- SQLite 探針不是 Cloudflare D1 runtime/transaction 實證；Vitest、Vite build、Wrangler Functions compile、瀏覽器互動、staging 與 CI 均未在本輪通過或執行，不能以第一輪 SHA 的 CI 當作本輪證據。
- `db.batch` 的條件式 SQL 和唯一鍵已做靜態/SQLite 驗證；仍須在可正常執行的 Cloudflare Vitest/D1 相容環境做併發實證，尤其是兩個同時 conversion POST，以及 batch 內後句是否看得到前句寫入的 history id。隔離 SQLite 依序可見不能代替這項。

## 建議下一步

在乾淨、完整 Node 22/24 依賴環境先執行四組 typecheck、`npm test`、`npm run build`、`npm run wrangler:check`，並確認新回歸檔執行。之後只在明確核准通知政策、排程與寄送權限後，另開變更實作受鑑別 dispatcher 與人工處理 `unknown` 狀態；在此之前維持 dry-run-only。
