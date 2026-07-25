# M3 招募模組 — 執行期獨立驗收報告

驗收日期：2026-07-25
驗收方式：實際啟動 `npx wrangler pages dev dist --port 8788`，以 `curl` 對 REST API 送出真實 HTTP 請求，逐項比對狀態碼與回應 JSON。未修改任何原始碼。

## 驗收前置處理

本機 `.wrangler/state` 殘留前次（M1/M2）驗收改過的密碼，`admin@demo.local` 已無法用 seed 預設密碼 `Demo1234!` 登入（回 401 `電子郵件或密碼錯誤。`），且新密碼未被記錄於任何交付文件。

處理方式：刪除 `.wrangler/state/v3/d1` 後重跑 `npx wrangler d1 migrations apply DB --local`，取得乾淨 seed 狀態再開始驗收（僅動本機 D1，未動原始碼）。

測試帳號來源：`README.md:20-26` 與 `migrations/0003_seed.sql`。

- admin：`admin@demo.local`
- employee：`chiahao.lin@demo.local`（emp-002）
- 初始密碼：`Demo1234!`，兩者皆先完成首次登入強制改密碼（改為 `AcceptM3-2026!`）

> 註：bash 工具會把請求 body 的 UTF-8 中文轉成 CP950，導致寫入 mojibake。改用 UTF-8 payload 檔 `curl --data-binary @file` 後正常，本報告所有中文欄位均以此方式送出。

---

## 逐條結果

| 項 | 結果 | 摘要 |
|----|------|------|
| R0 | PASS | 0005 已套用 |
| R1 | PASS | typecheck 全綠 |
| R2 | PASS | 22 tests / 5 files 全綠 |
| R3 | PASS | build 成功 |
| R4 | PASS | 2 職缺 + 4 候選人，4 個不同階段 |
| R5 | PASS | 五欄位全部存讀正確 |
| R6 | PASS | 讀 / 改 / 刪皆可用 |
| R7 | PASS | 開放→暫停→關閉，逐次讀回正確 |
| R8 | PASS | 六欄位全部存讀正確 |
| R9 | PASS | 讀 / 改 / 刪皆可用 |
| R10 | PASS | 同一候選人跨 2 職缺，且有跨職缺查詢途徑 |
| R11 | PASS | 候選人 × 時間 × 面試官可排可讀 |
| R12 | PASS | 多維度 1–5 分＋評語，維度為自由字串 |
| R13 | PASS | 0 分與 6 分皆 422 拒絕 |
| R14 | PASS | 兩輪並存，`roundNumber` 可分辨 |
| R15 | PASS | 期望／建議／核定薪資可寫可讀 |
| R16 | PASS | 範本帶入實際姓名／職缺／核定薪資 |
| R17 | PASS | 可新增自訂項目 |
| R18 | PASS | 勾選與取消皆持久化 |
| R19 | PASS | 三組到期日算式與系統值一致 |
| R20 | PASS | `/api/admin/dashboard` → `probationReminders` |
| R21 | PASS | 通過／延長／不通過三態皆可存 |
| R22 | PASS | 七階段（涵蓋規格六階段），每次轉移有 `changed_at` |
| R23 | PASS | 六階段走完，漏斗每步數字對應變化，時間戳齊全 |
| R24 | PASS | 18 個 admin M3 endpoint 全數 403 |
| R25 | PASS | 友善繁中訊息，無 stack trace |

FAIL：0 項。無法驗證：0 項。另有 2 點觀察事項見文末。

---

### R0 — migration 0005 已套用：PASS

`npx wrangler d1 migrations list DB --local` → `✅ No migrations to apply!`

直查 `d1_migrations`：0001～0005 五筆皆有 `applied_at`，`0005_m3_recruitment.sql` 在列。

### R1 — typecheck：PASS

`npm run typecheck`（client / worker / test / tooling 四個 tsconfig）無任何輸出、exit 0。

### R2 — 測試：PASS

- 整批跑 `npm test`：`Test Files 5 passed (5)`、`Tests 22 passed (22)`、4.64s。
- 單跑 `npx vitest run test/m3.test.ts`：`Test Files 1 passed (1)`、`Tests 4 passed (4)`、2.63s。

兩者皆全綠，無失敗，因此不存在測試互相干擾的問題。

### R3 — build：PASS

`npm run build` → `✓ built in 1.94s`，產出 `dist/index.html`、`index-*.css`、`index-*.js`。

### R4 — seed 資料：PASS

職缺 2 筆：`job-01 診所線業務代表`（診所事業部，需求 2）、`job-02 產品專員`（醫院事業部，需求 1）。

候選人 4 筆，**實際階段分佈為 4 個不同階段**：

| 候選人 | 職缺 | 階段 |
|--------|------|------|
| cand-01 蘇柏宇 | job-01 | `applied` 投遞 |
| cand-04 羅威廷 | job-02 | `screening` 篩選 |
| cand-02 何欣蓉 | job-01 | `interview` 面試 |
| cand-03 彭思妤 | job-02 | `offer` 發送錄取 |

來源：`migrations/0003_seed.sql:89-97`；`candidate_applications` 由 `migrations/0005_m3_recruitment.sql:22-46` 從 `candidates.job_opening_id` 移轉產生。

### R5 — 建立職缺五欄位：PASS

`POST /api/admin/recruitment/job-openings`
送出 `{title:"驗收工程師", department:"品保部", headcount:3, description:"負責 M3 驗收測試與缺陷追蹤。", status:"open"}` → HTTP 201。

`GET /job-openings` 讀回五欄位完全一致（中文未走樣），並附帶 `applicationCount` / `onboardedCount` 統計。

### R6 — 職缺讀／改／刪：PASS

- 讀：`GET /job-openings`（僅有清單端點，無單筆 GET；清單可讀到完整五欄位，符合需求）
- 改：`PATCH /job-openings/{id}` 改標題／需求人數／JD → HTTP 200，讀回為新值，`updatedAt` 有更新
- 刪：`DELETE /job-openings/{id}` → HTTP 200 `{deleted:true}`

另：對已有應徵紀錄的職缺刪除會回 409「此職缺已有應徵紀錄，請改為關閉而非刪除。」（`src/server/m3.ts:315-322`）

### R7 — 職缺狀態三態切換：PASS

每次 PATCH 後都重新 `GET` 讀回：

`open` → `paused`（讀回 `"status":"paused"`）→ `closed`（讀回 `"status":"closed"`）→ `open`（讀回 `"status":"open"`）。

非法狀態值回 422「職缺狀態必須是開放、暫停或關閉。」

### R8 — 建立候選人六欄位：PASS

`POST /candidates` 建立「驗收候選人甲」，六個需求欄位對應如下：

| 規格欄位 | API 欄位 | 實測值 |
|----------|----------|--------|
| 姓名 | `name` | 驗收候選人甲 |
| 聯絡方式 | `email` + `phone` | acceptance.a@example.com / 0987654321 |
| 來源 | `source` | 獵頭推薦 |
| 應徵職缺 | `candidate_applications`（另一端點） | job-01 |
| 履歷連結或備註 | `resumeUrl` + `notes` | https://example.com/resume/acceptance-a.pdf ／ 具五年品保經驗… |
| 目前狀態 | `applications[].status` | `applied` |

`POST /candidates/{id}/applications {jobOpeningId:"job-01"}` → 201。
`GET /candidates/{id}` 讀回候選人主檔 + `applications[]`，全部欄位一致。

註：`email` 與 `phone` 至少須填一項（`src/server/m3.ts:236`），格式錯誤的 email 會被拒。

### R9 — 候選人讀／改／刪：PASS

- 讀：`GET /candidates`（含搜尋 `?search=`）與 `GET /candidates/{id}`
- 改：`PATCH /candidates/{id}` 六欄位全改 → 200，讀回為新值
- 刪：`DELETE /candidates/{id}` → 200；再 `GET` → 404「找不到指定候選人。」

### R10 — 跨職缺再利用：PASS

**這條從嚴檢查，結論是通過。** 候選人並未被綁死單一職缺。

實測：
1. `POST /candidates/{C}/applications {jobOpeningId:"job-01"}` → 201
2. `POST /candidates/{C}/applications {jobOpeningId:"job-02"}` → 201（同一候選人，第二個職缺）
3. `GET /candidates/{C}` 的 `applications[]` **同時回傳兩筆**：
   - `jobOpeningId:"job-02", jobTitle:"產品專員", status:"applied"`
   - `jobOpeningId:"job-01", jobTitle:"診所線業務代表", status:"applied"`
4. `GET /applications?jobOpeningId=job-02` 回傳含「驗收候選人甲」的跨職缺查詢結果
5. 重複綁同一職缺 → 409「此候選人已應徵過該職缺。」（有唯一鍵保護）

架構上 `candidate_applications` 是獨立資料表（`migrations/0005_m3_recruitment.sql:1-20`），把人才主檔與應徵事件分離，即人才庫本質。另 `GET /candidates?jobOpeningId=` / `?status=` 也支援跨職缺篩選（`src/server/m3.ts:334-342`，用 `EXISTS` 子查詢而非直接欄位比對）。

### R11 — 面試排程：PASS

`POST /interviews` → 201，可指定：
- 候選人（透過 `applicationId`，回應含 `candidateId`/`candidateName`）
- 日期時間 `scheduledAt`（ISO 8601，`2026-08-05T02:00:00.000Z`）
- 面試官 `interviewerName`（王怡文（人資主管））
- 另有 `location` / `status` / `notes`

`GET /interviews?applicationId=...` 讀回全部欄位一致。

### R12 — 面試評分：PASS

`PUT /interviews/{id}/scores`，body 為 `scores[]`，每項 `{dimension, score, comments}`。

**實際支援的維度：自由字串，非固定列舉。** 後端只驗證 `dimension` 為必填字串（≤200 字）且不可重複（`src/server/m3.ts:761-763`）。前端預設帶三個維度並提供「新增面向」按鈕（`src/client/pages/M3AdminPages.tsx:466-468, 604`）：

- 預設：專業能力、溝通表達、文化契合
- 我實測送出 5 個自訂維度均成功存讀：專業知識(4)、溝通表達(5)、團隊合作(3)、抗壓性(4)、文化契合(1)，每項都帶繁中評語

`GET /interviews` 讀回時附 `scores[]`、`scoreCount` 與 `averageScore`。

### R13 — 評分邊界：PASS

| 送出 | 結果 |
|------|------|
| `score: 0` | HTTP 422 `{"message":"面試分數須為 1～5 的整數。"}` |
| `score: 6` | HTTP 422 同上 |
| `score: 3.5` | HTTP 422 同上（非整數也擋） |
| `score: "5"` | HTTP 422 同上（字串型別也擋） |
| `scores: []` | HTTP 422「請至少提供一項面試評分。」 |
| `score: 1` / `score: 5` | HTTP 200（邊界內值正常接受） |

另驗證：被拒的寫入不會破壞既有評分——`saveInterviewScores` 先跑完整驗證才進 `DELETE + INSERT` batch（`src/server/m3.ts:736-775`），實測 0/6 被拒後重查，原本 5 筆評分完好。

### R14 — 多輪面試：PASS

同一 `applicationId` 建立第 1 輪（王怡文，2026-08-05）與第 2 輪（林家豪，2026-08-12），皆 201。

`GET /interviews?applicationId=...` 同時回傳兩筆，以 `roundNumber` 1 / 2 分辨，各自有獨立的面試官、時間、地點與評分集合。同輪次重複建立會回 409「此應徵紀錄已有相同輪次的面試。」

### R15 — 核薪三欄位：PASS

`PUT /salary-approvals/{applicationId}` 送出並讀回：

- `expectedSalary` 期望薪資：62000
- `suggestedSalary` 建議薪資：58000
- `approvedSalary` 核定薪資：60000
- 另有 `compensationNotes`、`status`、`approvedBy`、`approvedAt`

`GET /salary-approvals` 讀回一致，並帶 `approvedAt:"2026-07-25T01:47:32.900Z"`、`candidateName:"蘇柏宇"`。

業務規則：`status:"approved"` 但未填 `approvedSalary` → 422「核准時必須填寫核定薪資。」

### R16 — 錄取通知範本：PASS

`GET /offers/app-cand-01/template` 回傳可直接複製的 `noticeText`，**已帶入實際值而非空模板**：

```
蘇柏宇 您好：

很高興通知您錄取本公司「診所事業部－診所線業務代表」職務。
核定月薪：新台幣 60,000 元
...
```

- 候選人姓名 → `蘇柏宇`（實際 seed 值）
- 職缺 → `診所事業部－診所線業務代表`（實際部門＋職稱）
- 薪資 → `60,000`（實際核定薪資，且套 `toLocaleString("zh-TW")` 千分位）

未核薪時會 fallback 為「薪資條件請參閱附件或與 HR 聯繫」（`src/server/m3.ts:891-893`），符合「有值就帶入」語意。`PUT /offers/{id}` 可覆寫編輯後的文字。

### R17 — 自訂 checklist 項目：PASS

`POST /onboarding-items` 建立自訂項目「驗收自訂項目：離職證明影本」（`required:true`）→ 201。

`GET /onboarding-items` 讀回 5 筆：seed 的 4 筆固定項（身分證影本、體檢報告、保證書、薪轉帳戶資料）**加上**我新增的自訂項。另有 `PATCH`（改名／改必填）與 `DELETE`（軟停用 `active=0`）。

**清單非寫死**：`onboarding_items` 是可 CRUD 的資料表，`required` 可切必填／選填。名稱重複會回 409。

### R18 — checklist 勾選與取消：PASS

`PUT /applications/{appId}/onboarding-checklist/{itemId}`

1. 5 項全部勾選（含自訂項）→ 全 200
2. **重新查詢** `GET .../onboarding-checklist` → 5 項皆 `completed:1`，各有 `completedAt` 時間戳與備註「已於 2026-07-25 收件並存檔。」
3. 對自訂項送 `{completed:false}` → 200
4. **再次重新查詢** → 該項 `completed:0`、`completedAt:null`、備註更新為「取消勾選：文件需重新補件。」；其餘 4 項維持 `completed:1` 不受影響

勾選狀態、完成時間與備註三者皆持久化。

### R19 — 試用期到期日計算：PASS

系統實作為 `startDate + durationDays`（UTC 日期加法，`src/server/m3.ts:206-210`）。我自己算三組對照（2026 非閏年）：

| 到職日 | 試用期 | 我的算式 | 系統值 | 一致 |
|--------|--------|----------|--------|------|
| 2026-05-01 | 90 天 | 5/1 = 年內第 121 日；121+90 = 第 211 日；7 月起於第 182 日 → 211−181 = **7/30** | `2026-07-30` | ✅ |
| 2026-07-20 | 30 天 | 7/20 = 第 201 日；201+30 = 第 231 日；8 月起於第 213 日 → 231−212 = **8/19** | `2026-08-19` | ✅ |
| 2026-02-28 | 1 天 | 2026 非閏年，無 2/29 → **3/1** | `2026-03-01` | ✅ |

跨月、跨季與非閏年 2 月邊界皆正確。

### R20 — 到期前提醒出現在 admin 儀表板：PASS

`GET /api/admin/dashboard` 回應含 **`probationReminders`** 陣列（`src/server/m2.ts:222` 的 dashboard 引用 `probationReminders()`，`src/server/m3.ts:1065`）。

實測（當日 2026-07-25，`probation_reminder_days` 預設 14）：

- 到期日 `2026-07-30`（`daysUntilDue:5`）→ **出現**在提醒中，附員工編號、姓名、部門
- 到期日 `2026-03-01`（`daysUntilDue:-146`）→ **出現**（已逾期持續顯示）
- 到期日 `2026-08-19`（25 天後，超出 14 天視窗）→ **正確排除**

已記錄結果（`result` 非 null）的紀錄會自動移出提醒——三筆都填結果後 `reminders` 變為 `[]`。提醒天數可由 `PATCH /probation-settings` 調整。

### R21 — 試用期結果三態：PASS

| 送出 `result` | HTTP | 讀回 |
|---------------|------|------|
| `passed` 通過 | 200 | `張志明` / due 2026-07-30 / `"result":"passed"` |
| `extended` 延長 | 200 | `李佩珊` / due 2026-08-19 / `"result":"extended"` |
| `failed` 不通過 | 200 | `黃冠宇` / due 2026-03-01 / `"result":"failed"` |
| `bogus` | 422 | 「試用期結果不正確。」 |

三態皆存得進去、`GET /probations` 讀得回來。

### R22 — 狀態機階段與時間戳：PASS

實作為 **7 階段**，涵蓋規格要求的 6 階段（把「錄取」細分為「發送錄取」與「錄取」）：

| # | 內部值 | `label` | 規格對應 |
|---|--------|---------|----------|
| 1 | `applied` | 投遞 | 投遞 |
| 2 | `screening` | 篩選 | 篩選 |
| 3 | `interview` | 面試 | 面試 |
| 4 | `salary_approval` | 核薪 | 核薪 |
| 5 | `offer` | 發送錄取 | 錄取（發送階段） |
| 6 | `hired` | 錄取 | 錄取（接受階段） |
| 7 | `onboarded` | 到職 | 到職 |

另有 `rejected`（淘汰）為流程外終態。

**時間戳欄位名稱**（`candidate_application_status_history`，`migrations/0005_m3_recruitment.sql:49-67`）：

| DB 欄位 | API 欄位 |
|---------|----------|
| `id` | `id` |
| `application_id` | —（路徑參數） |
| `from_status` | `fromStatus` |
| `to_status` | `toStatus` |
| `changed_by` | `changedBy`（回傳操作者 email） |
| `note` | `note` |
| **`changed_at`** | **`changedAt`** |

每次 `POST /applications/{id}/transition` 都以 batch 同時 UPDATE 狀態並 INSERT 一筆 history（`src/server/m3.ts:566-580`），時間戳不會漏。

狀態機為 forward-only：跳階會回 409「不可由「X」直接轉為「Y」，請依招募流程逐步操作。」

### R23 — 全流程走通＋漏斗數字對應變化：PASS

走了**兩次**完整流程。第二次每一階段變更後都查一次 `GET /funnel`，完整記錄如下（格式 `目前人數/歷史進入人數`）：

| 操作後 | 投遞 | 篩選 | 面試 | 核薪 | 發送錄取 | 錄取 | 到職 |
|--------|------|------|------|------|----------|------|------|
| S0 基準 | 2/3 | 1/2 | 1/2 | 0/1 | 1/2 | 0/1 | 1/1 |
| S1 →篩選 | **1**/3 | **2**/**3** | 1/2 | 0/1 | 1/2 | 0/1 | 1/1 |
| S2 →面試 | 1/3 | **1**/3 | **2**/**3** | 0/1 | 1/2 | 0/1 | 1/1 |
| S3 →核薪 | 1/3 | 1/3 | **1**/3 | **1**/**2** | 1/2 | 0/1 | 1/1 |
| S4 →發送錄取 | 1/3 | 1/3 | 1/3 | **0**/2 | **2**/**3** | 0/1 | 1/1 |
| S5 →錄取 | 1/3 | 1/3 | 1/3 | 0/2 | **1**/3 | **1**/**2** | 1/1 |
| S6 →到職 | 1/3 | 1/3 | 1/3 | 0/2 | 1/3 | **0**/2 | **2**/**2** |

每一步 `currentCount` 從前一階段減 1、目標階段加 1，`enteredCount` 單調遞增，數字完全對應。

**六階段時間戳全部有值**（`GET /applications/{id}/history`）：

```
null            -> applied          2026-07-25T01:34:20.576Z
applied         -> screening        2026-07-25T01:52:55.860Z
screening       -> interview        2026-07-25T01:52:56.202Z
interview       -> salary_approval  2026-07-25T01:52:56.900Z
salary_approval -> offer            2026-07-25T01:52:57.443Z
offer           -> hired            2026-07-25T01:52:57.993Z
hired           -> onboarded        2026-07-25T01:52:59.393Z
```

7 筆紀錄，每筆都有 `changedAt` 與 `changedBy: admin@demo.local`。

第一次走 seed 候選人 **cand-01 蘇柏宇**（`app-cand-01`），結果相同，history 同樣 7 筆完整。

流程中的守門條件也逐一實測有效（都是 409 + 繁中訊息）：

| 嘗試 | 回應 |
|------|------|
| 面試→核薪，但無已完成面試評分 | 409「至少須完成一輪面試並登錄評分，才能進入核薪。」 |
| 發送錄取→錄取，但通知未被接受 | 409「候選人接受錄取通知後，才能標記為錄取。」 |
| 錄取→到職，但必填文件未完成 | 409「必填到職文件尚未全部完成，無法標記到職。」 |

（`salary_approval → offer` 需先核定薪資並核准，由 `src/server/m3.ts:518-527` 保證。）

### R24 — 權限（employee token 打 admin API）：PASS

以 `chiahao.lin@demo.local`（employee）的 session cookie 打 **18 個** admin M3 endpoint，**全數 HTTP 403** `{"ok":false,"error":{"message":"您沒有執行此操作的權限。"}}`：

**(a) 核薪 API** — 全部 403
- `GET /salary-approvals`
- `PUT /salary-approvals/{id}`
- `DELETE /salary-approvals/{id}`

**(b) 面試評分 API** — 全部 403
- `GET /interviews`
- `PUT /interviews/{id}/scores`
- `POST /interviews`

**(c) 候選人／履歷 API** — 全部 403
- `GET /candidates`
- `GET /candidates/{id}`（含 `resumeUrl` 履歷連結）
- `POST /candidates`
- `GET /applications`

**額外檢查（皆 403）**：`/job-openings`、`/funnel`、`/offers`、`/offers/{id}/template`、`/probations`、`/onboarding-items`、`/applications/{id}/onboarding-checklist`、`POST /applications/{id}/transition`

強制點在 API 層而非前端，且有雙層保護：
- Router 層 `src/server/router.ts:62-63` — 凡 `/api/admin/` 開頭一律先 `requireAdmin(user)`
- Handler 層 `src/server/m3.ts:1208` — `handleAdminM3` 第一行再 `requireAdmin(context.user)`

補充驗證：
- 未帶 token 打 `/candidates` → 401「請先登入。」
- M3 **完全沒有 employee 端點**（`m3.ts` 只 export `handleAdminM3`，router 的 employee 分支只掛 M1/M2），因此員工端無任何管道取得薪資、履歷或面試評分
- `GET /api/employee/home` 回應中 grep 不到 `salary`／`candidate`／`probation`／`offer`／`interview_score` 任何字樣

### R25 — 錯誤處理：PASS

**(a) 缺必填欄位的職缺**

| 送出 | HTTP | 訊息 |
|------|------|------|
| `{}` | 422 | 職稱為必填。 |
| 缺 department | 422 | 部門為必填。 |
| 缺 description | 422 | 職務說明為必填。 |
| `headcount: 0` | 422 | 需求人數須為 1～1000 的整數。 |
| `status: "weird"` | 422 | 職缺狀態必須是開放、暫停或關閉。 |

**(b) 超出範圍的評分**

| 送出 | HTTP | 訊息 |
|------|------|------|
| `score: 0` | 422 | 面試分數須為 1～5 的整數。 |
| `score: 6` | 422 | 面試分數須為 1～5 的整數。 |
| `score: 3.5` | 422 | 面試分數須為 1～5 的整數。 |
| `scores: []` | 422 | 請至少提供一項面試評分。 |

**其他**

| 情境 | HTTP | 訊息 |
|------|------|------|
| 壞掉的 JSON | 400 | JSON 格式不正確。 |
| 不存在的職缺 | 404 | 找不到指定職缺。 |
| 未登入 | 401 | 請先登入。 |
| 權限不足 | 403 | 您沒有執行此操作的權限。 |

全部為友善繁體中文，回應一律只有 `{ok:false, error:{message}}`，**未見任何 stack trace、SQL 片段或內部欄位名**。未預期例外統一被 `errorResponse` 收斂成 500「系統暫時無法處理此要求，請稍後再試。」（`src/server/http.ts:35`）。

---

## 觀察事項（非 FAIL，但建議記錄）

**1. seed 候選人沒有上游階段歷程，會影響 M4 漏斗報表的「歷史進入人數」**

`migrations/0005_m3_recruitment.sql:69-86` 對每筆移轉來的應徵只寫**一筆** history（`NULL → 目前階段`）。實查 history 筆數：

| 應徵 | 目前階段 | history 筆數 |
|------|----------|--------------|
| app-cand-01（我走完全程） | onboarded | 7 |
| app-cand-02 | interview | **1** |
| app-cand-03 | offer | **1** |
| app-cand-04 | screening | **1** |

因此 `funnel` 的 `enteredCount`（歷史進入人數）對 seed 候選人是低估的——cand-03 在「發送錄取」階段，卻從未被計入「投遞／篩選／面試」的歷史進入數。透過 API 實際操作的每一次轉移都有完整時間戳，這純粹是 seed 移轉的資料造型問題，但 M4 若直接拿 `enteredCount` 畫漏斗轉換率會失真。

**2. 本機 demo 帳號密碼在跨階段驗收間會失聯**

seed 強制首次改密碼是正確設計，但前次驗收改過的密碼未留存，導致本次無法沿用既有 D1 狀態、必須重建。建議在驗收流程約定固定的改後密碼，或每輪驗收前先重置本機 D1。

---

## 實際檢查範圍

**打過的 endpoint（全部以真實 HTTP 請求驗證，非讀 code 推論）**

- Auth：`POST /api/auth/login`、`POST /api/auth/change-password`、`GET /api/auth/me`
- 職缺：`GET|POST /job-openings`、`PATCH|DELETE /job-openings/{id}`
- 候選人：`GET|POST /candidates`、`GET|PATCH|DELETE /candidates/{id}`、`POST /candidates/{id}/applications`
- 應徵：`GET /applications`（含 `?jobOpeningId=`）、`GET /applications/{id}/history`、`POST /applications/{id}/transition`
- 漏斗：`GET /funnel`（共查 12 次，走兩輪流程逐階段比對）
- 面試：`GET|POST /interviews`、`PUT /interviews/{id}/scores`
- 核薪：`GET /salary-approvals`、`PUT /salary-approvals/{id}`
- 錄取：`GET /offers`、`GET /offers/{id}/template`、`PUT /offers/{id}`
- 到職文件：`GET|POST /onboarding-items`、`GET /applications/{id}/onboarding-checklist`、`PUT /applications/{id}/onboarding-checklist/{itemId}`
- 試用期：`GET|POST /probations`、`PATCH /probations/{id}`
- 儀表板：`GET /api/admin/dashboard`
- 員工端：`GET /api/employee/home`、`/schedule`、`/certifications`

**驗證手法**

- 每個「存得進去」都配一次獨立的重新 `GET` 查詢確認持久化，不採信 POST/PUT 的回應 echo
- 邊界值（0/6/3.5/字串/空陣列）與必填缺漏都實際送出並記錄狀態碼與訊息全文
- 到期日計算自行以年內日序算過三組對照，未直接採信系統輸出
- 權限測試涵蓋 18 個 endpoint × GET/POST/PUT/DELETE 多種動詞，非只抽驗一兩個
- 直查本機 D1（`wrangler d1 execute`）交叉驗證 seed 內容與 history 筆數

**未涵蓋**

- 前端 UI 互動（本次為 API 層執行期驗收，僅讀 `M3AdminPages.tsx` 確認預設評分維度）
- 遠端 D1 / 實際部署環境
- 併發／競態行為與效能

## Dev server 狀態

已關閉。`npx wrangler pages dev dist --port 8788` 的 node 與 workerd 行程皆已 `Stop-Process` 終止，`Get-NetTCPConnection -LocalPort 8788` 查無 listener，port 已釋放。
