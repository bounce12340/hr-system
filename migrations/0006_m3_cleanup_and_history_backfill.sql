-- 0006：M3 收尾——補齊種子資料的上游階段歷程，並清除已被 0005 取代的孤兒表。
--
-- 背景（M3 驗收發現，見 ACCEPTANCE-M3.md §四）：
-- 0005 對移轉來的每筆應徵只寫一列 `NULL → 目前階段` 的歷程，因此停在
-- 後段階段的種子候選人，從未被計入前面各階段的「曾進入」數。M4 招募漏斗
-- 若以 entered count 繪製，上游數字會被低估。此處補齊完整階段鏈。

-- ---------------------------------------------------------------------------
-- 一、補齊種子應徵的上游階段歷程
-- ---------------------------------------------------------------------------
-- 僅處理「只有 0005 那一列移轉紀錄」的應徵，避免覆蓋任何經 API 實際操作
-- 產生的真實歷程。'rejected' 不處理：淘汰發生在哪一階段無法從現有資料推得。

-- 註：階段序表以 CTE + VALUES 表達。先前以三組 UNION ALL 子查詢實作會觸發
-- D1 的 "too many terms in compound SELECT" 限制。

WITH stage_order(stage, ord) AS (
  VALUES
    ('applied', 0),
    ('screening', 1),
    ('interview', 2),
    ('salary_approval', 3),
    ('offer', 4),
    ('hired', 5),
    ('onboarded', 6)
)
INSERT INTO candidate_application_status_history (
  id,
  application_id,
  from_status,
  to_status,
  changed_by,
  note,
  changed_at
)
SELECT
  'app-history-' || ca.candidate_id || '-' || s.ord,
  ca.id,
  prev.stage,
  s.stage,
  (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1),
  '種子資料補齊之階段歷程',
  MIN(
    strftime('%Y-%m-%dT%H:%M:%fZ', datetime(ca.applied_at, '+' || (s.ord * 2) || ' days')),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
FROM candidate_applications ca
JOIN stage_order cur ON cur.stage = ca.status
JOIN stage_order s ON s.ord <= cur.ord
LEFT JOIN stage_order prev ON prev.ord = s.ord - 1
WHERE ca.status <> 'rejected'
  AND (
    SELECT COUNT(*)
    FROM candidate_application_status_history h
    WHERE h.application_id = ca.id
  ) = 1;

-- 移除 0005 留下的單列移轉紀錄（其語意已由上方完整階段鏈取代）。
DELETE FROM candidate_application_status_history
WHERE note = '由既有候選人資料移轉';

-- ---------------------------------------------------------------------------
-- 二、清除已被 0005 取代的孤兒表
-- ---------------------------------------------------------------------------
-- 三張表在 0005 導入新結構後即無任何程式碼參照（已逐一以 SQL 關鍵字邊界
-- 確認無 FROM／JOIN／INTO／UPDATE／DELETE 命中）。其中 offers 與規格 §六
-- 點名的表同名，保留孤兒版本會誤導讀者，故一併移除：
--   offers                    → 由 application_offers 取代
--   onboarding_checklist      → 由 application_onboarding_checklist 取代
--   candidate_status_history  → 由 candidate_application_status_history 取代

DROP TABLE IF EXISTS offers;
DROP TABLE IF EXISTS onboarding_checklist;
DROP TABLE IF EXISTS candidate_status_history;

-- ---------------------------------------------------------------------------
-- 三、移除只索引死欄位的索引
-- ---------------------------------------------------------------------------
-- candidates.job_opening_id 與 candidates.status 自 0005 起改由
-- candidate_applications 承載，兩者皆已無讀寫。索引本身只剩寫入成本。
--
-- 註：這兩個欄位本身「不」在此移除。SQLite 的 DROP COLUMN 不支援移除帶有
-- CHECK 約束的欄位（candidates.status 有 CHECK），要清除必須整表重建；而
-- candidate_applications 有 FK 指向 candidates(id)，在 D1 migration 中重建
-- 風險高於效益。兩欄位保留為 pre-0005 的殘留，不再使用。

DROP INDEX IF EXISTS idx_candidates_opening_status;
