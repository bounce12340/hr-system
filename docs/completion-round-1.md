# 第一輪補完紀錄

基準 master@751063e；分支 improve/completion-round-1。

## 完成實作
- GitHub Actions CI：Node 22.23.2/24.21.0，npm ci、typecheck、Vitest、Vite build、Functions編譯；僅contents:read，無部署與正式環境secret。
- 招募狀態：D1原子batch先條件式INSERT SELECT歷程再條件UPDATE；過期狀態回409、不產生假歷程。流程前置條件仍在交易外驗證，不宣稱全部競爭已消除。
- 出缺勤：唯一索引migration0014；手動/CSV原子upsert並保留id，正確回報新增/更新；PATCH唯一衝突回409。
- 測驗編輯：名稱、場次、及格門檻、取消、忙碌保護、草稿切換確認；已有分數不可換場，門檻更新與重算原子batch；成績寫入讀當下門檻並拒絕過期場次。
- 新增D1與SSR測試、確定性stale-write測試。SSR只驗初始呈現，不代表瀏覽器互動驗證。

## 已實際驗證
- client/worker/test/tools四個tsconfig型別檢查通過（直接node執行tsc）。
- git diff --check通過。
- python3 scripts/verify-consistency-sqlite.py：5組獨立SQLite探針通過，含全部14個migration、重複資料拒絕且不刪資料、實際程式SQL之upsert/狀態/判分/場次防護。
- 上述SQLite不是Cloudflare D1 runtime或正式Vitest。

## 未完成驗證
- iOS npm標準安裝遭快取EEXIST與symlink EPERM。以獨立快取/no-bin-links/ignore-scripts嘗試後依賴仍不完整；TypeScript標準宣告從相同5.8.3官方npm archive復原，未改lockfile。
- Vitest與Vite被rolldown native binding ERR_DLOPEN_FAILED阻擋；未有測試通過數。
- Functions編譯因本機缺wrangler入口而未完成。
- CI已寫但尚未push/執行；真瀏覽器互動、staging未驗證。不得直接部署。

## Migration部署閘門
僅在隔離SQLite執行，未碰正式D1。正式套用前先唯讀預檢：
```sql
SELECT employee_id, attendance_date, COUNT(*) AS row_count,
       group_concat(id, ',') AS record_ids
FROM attendance GROUP BY employee_id, attendance_date
HAVING COUNT(*) > 1;
```
有重複時0014會安全失敗，不會自動合併/刪除。由資料負責人決定处理。先備份/還原演練與staging，再套migration，最後上新版程式；新版upsert依賴唯一索引。

## 尚待下一輪
到職轉員工、主動通知、角色細分、正式seed隔離、備份維運、效期/歷史資料與其他產品擴充均未在本輪完成。不push、不合併、不部署。
