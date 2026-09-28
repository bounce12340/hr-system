# 第二輪本機補完紀錄

## 範圍與授權

- 工作樹：`/var/minis/workspace/hr-system`；分支 `improve/completion-round-2`；接手基準 HEAD `595bc86b4e0704db0110fc2d2a2d56296b21aea5`。接手時已存在未提交草稿，已逐檔審查後以最小修正保留並完成，沒有 reset、clean、stash 或覆蓋他人變更。
- 本輪僅本機程式、隔離 SQLite 與靜態驗證。**未** push、PR、merge、deploy、遠端 D1 操作、讀取正式資料/secret、寄送真實信件或啟用任何排程。
- 完成到職轉員工主檔與「通知 outbox 的安全準備」；不是通知正式上線。

## 完成實作

### 到職轉員工

- 新增管理員專用 `POST /api/admin/recruitment/applications/:id/convert-employee`。全域 `/api/admin/` 授權閘門及 M3 的 `requireAdmin` 均會執行；一般員工不可使用。
- 要求 `confirmed: true` 及明確填寫員編、候選人同一 Email、部門、職等、職務、啟用中的職務類型與到職日；薪資可由 HR 明確留空。前端提供核對表單，不預設職等或薪資。
- 僅允許 `hired` 應徵、必填到職文件已完成、職務類型仍啟用、候選人 Email 一致、且員編/Email 未被使用的資料。在同一個條件式 D1 batch 中重複檢查這些可變前置條件，依序建立員工、轉換對應、`hired → onboarded` 歷程、狀態與 audit log；任一前置條件失效時不建立員工。
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

## 本機驗證證據

全部都在此工作樹及合成/seed 資料執行：

- 四組 TypeScript：
  - `node node_modules/typescript/bin/tsc -p tsconfig.client.json --noEmit`：通過。
  - `node node_modules/typescript/bin/tsc -p tsconfig.worker.json --noEmit`：通過。
  - `node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit`：通過。
  - `node node_modules/typescript/bin/tsc -p tsconfig.tools.json --noEmit`：通過。
- `python3 scripts/verify-consistency-sqlite.py`：通過 5 項既有一致性探針（全部 14 個舊 migration、出缺勤唯一性、招募 stale history、測驗場次/門檻）。
- `python3 scripts/verify-completion-round-2-sqlite.py`：通過 4 項第二輪探針：全部 15 個 migration；到職條件 INSERT 僅一次/重送拒絕；缺少必填文件阻擋；outbox dedup key 與 `unknown` 狀態保留。
- `git diff --check`：通過。
- 新增 `test/completion-round-2.test.ts` 回歸案例涵蓋：兩個相同 payload 併發請求（一個建立、另一個冪等回覆）、不同 payload 衝突重送、缺少確認、未完成到職文件、跨角色、audit/未建帳號，以及 dry-run、disabled、outbox 不寫入、非管理員拒絕。

## 驗證限制與剩餘風險

- 嘗試 `npm test -- --run test/completion-round-2.test.ts` 失敗，原因為本機 `node_modules/.bin/vitest` 缺失；直接跑 `node node_modules/vitest/vitest.mjs run test/completion-round-2.test.ts` 也在 Vite 載入設定前失敗：`node_modules/vite/dist/node/module-runner.js` 不存在（先前已知 iOS/native rolldown/Vite 依賴不完整問題）。未修改 lockfile、未降低測試或安全檢查、未以 SQLite 冒充 Vitest/D1。
- SQLite 探針不是 Cloudflare D1 runtime/transaction 實證；Vitest、Vite build、Wrangler Functions compile、瀏覽器互動、staging 與 CI 均未在本輪通過或執行，不能以第一輪 SHA 的 CI 當作本輪證據。
- `db.batch` 的條件式 SQL 和唯一鍵已做靜態/SQLite 驗證；仍須在可正常執行的 Cloudflare Vitest/D1 相容環境做併發實證，尤其是兩個同時 conversion POST 的相同/不同 payload 分支。

## 建議下一步

在乾淨、完整 Node 22/24 依賴環境先執行四組 typecheck、`npm test`、`npm run build`、`npm run wrangler:check`，並確認新回歸檔執行。之後只在明確核准通知政策、排程與寄送權限後，另開變更實作受鑑別 dispatcher 與人工處理 `unknown` 狀態；在此之前維持 dry-run-only。
