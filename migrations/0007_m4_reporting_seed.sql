-- 0007：M4 報表模組種子資料。
--
-- 背景：M4 的六項指標橫跨 M1/M2/M3，但其中三項所依賴的欄位／資料表在
-- 0001 建好後從未被寫入，導致指標恆為 0，無法驗收：
--   employees.termination_date / status → 離職率恆為 0%
--   employees.salary                    → 僅 0003 種子有值，離職者不存在
--   attendance                          → 全表無資料，缺勤與加班統計為空
-- 本 migration 只補資料，不改結構（唯一例外是新增一組報表用 setting）。
--
-- 注意：M4 的缺勤／加班一律取自 attendance 表；enrollments.attendance_status
-- 是 M1 訓練場次簽到，語意不同，不得混用。

-- ---------------------------------------------------------------------------
-- 一、離職員工
-- ---------------------------------------------------------------------------
-- 改為將既有員工標記離職，而非新增員工列，理由：
--   1. 規格 §八 要求種子員工僅 12～15 人；若在 0003 的 15 人之外再新增 3 人，
--      總數會變成 18 人，超出規格範圍。
--   2. 選定 emp-013（人資行政部 G2）、emp-011（診所事業部 G4）、
--      emp-009（醫院事業部 G3）三人：三人分屬三個部門、三個職等，避免部門
--      與職等篩選測試因此塌成只剩兩個維度；且三人在 test/ 下沒有被任何案例
--      指名引用，改動不會牽動非本次意圖的斷言。
--   3. 刻意保留 emp-002（林家豪）在職——README 記載其為 demo 員工登入帳號，
--      且其名下掛有即將到期的證照（0003 的 ec-01），是既有到期提醒測試資料，
--      標記離職會連帶讓那筆測試資料消失。
-- 標記離職會改變既有查詢結果：activeEmployees／completionData／
-- mandatoryTraining（src/server/m1.ts:207、:823、src/server/m2.ts:274）皆以
-- status = 'active' 為前提，故 test/m1.test.ts 的全員必訓指派人數、中級必修
-- 推薦名單，以及 test/m4.test.ts 內所有寫死的人數／金額／比率都需同步重算。
-- 日期以 date('now', ...) 相對計算，確保永遠落在最近 6 個月的預設期間內；
-- 刻意不選當月（避免 '+N day' 位移超過「今天」而變成未來日期）。
-- 三人分屬三個不同月份，方便驗證部門與期間篩選。

UPDATE employees
SET status = 'inactive',
    termination_date = date('now', 'start of month', '-4 month', '+14 day')
WHERE id = 'emp-011';

UPDATE employees
SET status = 'inactive',
    termination_date = date('now', 'start of month', '-2 month', '+19 day')
WHERE id = 'emp-009';

UPDATE employees
SET status = 'inactive',
    termination_date = date('now', 'start of month', '-1 month', '+9 day')
WHERE id = 'emp-013';

-- ---------------------------------------------------------------------------
-- 二、出缺勤資料
-- ---------------------------------------------------------------------------
-- 以 CTE + VALUES 表達（月份位移、當月日期），再由 SELECT 換算成實際日期。
-- 不使用一長串 UNION ALL：0006 已踩過 D1 的 "too many terms in compound
-- SELECT"，且每個 INSERT 的 VALUES 列數控制在 10 列以內。
-- 涵蓋 6 個月、5 名員工（含 emp-011、emp-009 兩名離職者於在職期間的紀錄）、
-- manual 與 csv 兩種來源，absence_hours 與 overtime_hours 均有非零值。

WITH attendance_seed(
  id, employee_id, month_offset, day_of_month, absence_hours, overtime_hours, absence_type, source
) AS (
  VALUES
    ('att-001', 'emp-002', 5, 5, 8, 4, '事假', 'manual'),
    ('att-002', 'emp-004', 5, 12, 0, 6, NULL, 'csv'),
    ('att-003', 'emp-006', 5, 20, 4, 0, '病假', 'csv'),
    ('att-004', 'emp-002', 4, 6, 0, 8, NULL, 'manual'),
    ('att-005', 'emp-011', 4, 13, 16, 0, '特休', 'manual'),
    ('att-006', 'emp-011', 4, 5, 8, 2, '病假', 'csv'),
    ('att-007', 'emp-004', 3, 7, 8, 4, '特休', 'csv'),
    ('att-008', 'emp-006', 3, 14, 0, 10, NULL, 'manual'),
    ('att-009', 'emp-011', 3, 21, 4, 2, '事假', 'csv')
)
INSERT INTO attendance (
  id, employee_id, attendance_date, absence_hours, overtime_hours, absence_type, source, notes
)
SELECT
  id,
  employee_id,
  date('now', 'start of month', '-' || month_offset || ' month', '+' || (day_of_month - 1) || ' day'),
  absence_hours,
  overtime_hours,
  absence_type,
  source,
  '種子資料'
FROM attendance_seed;

WITH attendance_seed(
  id, employee_id, month_offset, day_of_month, absence_hours, overtime_hours, absence_type, source
) AS (
  VALUES
    ('att-010', 'emp-002', 2, 8, 16, 0, '特休', 'manual'),
    ('att-011', 'emp-004', 2, 15, 0, 12, NULL, 'manual'),
    ('att-012', 'emp-009', 2, 5, 8, 0, '病假', 'csv'),
    ('att-013', 'emp-006', 1, 9, 8, 6, '病假', 'manual'),
    ('att-014', 'emp-011', 1, 16, 0, 4, NULL, 'csv'),
    ('att-015', 'emp-002', 1, 23, 4, 2, '事假', 'csv'),
    ('att-016', 'emp-004', 0, 3, 8, 0, '特休', 'manual'),
    ('att-017', 'emp-006', 0, 10, 0, 8, NULL, 'csv'),
    ('att-018', 'emp-011', 0, 17, 2, 6, '事假', 'manual')
)
INSERT INTO attendance (
  id, employee_id, attendance_date, absence_hours, overtime_hours, absence_type, source, notes
)
SELECT
  id,
  employee_id,
  date('now', 'start of month', '-' || month_offset || ' month', '+' || (day_of_month - 1) || ' day'),
  absence_hours,
  overtime_hours,
  absence_type,
  source,
  '種子資料'
FROM attendance_seed;

-- ---------------------------------------------------------------------------
-- 三、報表預設期間
-- ---------------------------------------------------------------------------
-- 未指定 startMonth／endMonth 時，報表回溯的月數（含當月）。
INSERT OR IGNORE INTO settings (setting_key, setting_value, value_type, description)
VALUES ('report_default_period_months', '6', 'number', '報表未指定起迄月份時回溯的月數（含當月）');

-- ---------------------------------------------------------------------------
-- 四、報表用索引
-- ---------------------------------------------------------------------------
-- 離職率與人力結構皆以 termination_date 做期間篩選；0002 只有
-- (department, status) 與 (job_type_id, status) 兩組索引，無法支援。
CREATE INDEX IF NOT EXISTS idx_employees_termination ON employees(termination_date, department);
