-- 0009：補齊「歷史訓練紀錄」與「歷史招募時間軸」種子資料。
--
-- 背景（M4 驗收發現）：
--   1. training_records 為 0 筆——0003 的 6 個場次全部是未來場次
--      （session_date 用 date('now', '+N day')），從未有人「完成」過，
--      教育訓練完成率報表因此全公司恆為 0%，看不出報表本身算對算錯。
--   2. candidate_applications.applied_at 全部等於套用 migration 當下
--      （0005:17 的欄位預設值），沒有任何時間縱深，招募漏斗一旦帶入
--      非當月的期間篩選就必然是空的。
-- 報表計算邏輯本身沒有問題（見 src/server/m1.ts completionData、
-- src/server/m3.ts funnelData），純粹是種子資料缺歷史縱深，此處只補資料。

-- ---------------------------------------------------------------------------
-- 一、歷史訓練紀錄
-- ---------------------------------------------------------------------------
-- 完訓紀錄不能憑空塞：enrollments.attendance_status 與 training_records 必須
-- 與 src/server/m1.ts:748-770 的 recordAttendance() 寫入邏輯同構——
-- 場次（過去）→ 報名（enrollments）→ 出席登錄 completed → training_records，
-- 四者一致，且 hours／valid_until 一律衍生自 courses，不自訂數值。
--
-- 刻意涵蓋全部 7 個必修課程（3 個一階、2 個二階、2 個三階），橫跨最近 5 個月，
-- 且完成率刻意做出落差：一階（全員必修）幾乎人人完成；二階只開放給診所線／
-- 醫院線，完成率中等；三階只開放給醫院線，完成率偏低。三個部門在此資料集
-- 中與職務類型一一對應（人資行政部＝內勤／診所事業部＝診所線／醫院事業部＝
-- 醫院線），因此職務等級落差會自然反映成部門完成率落差，不需額外調整。
-- 只為在職員工（12 人，0007 已將 emp-009／011／013 標記離職）建立完訓紀錄，
-- 離職者不應繼續累積訓練時數；分母（completionData 的 requiredCount）本來就
-- 只計算 e.status = 'active'，故不會因本節資料失真。
--
-- 每個場次的報名對象採用與 0003 相同的規則（依 courses.competency_level 對比
-- job_types.required_level），部分人刻意標記 'absent'（而非全員 completed），
-- 藉此在同一部門內也保留個體差異，避免任何一格是死板的 100% 或 0%。

-- 1-1｜過去場次：7 堂必修課，session_date 一律用 date('now', ...) 相對計算，
-- 確保任何時間套用種子都落在「已結束」的過去（最舊 -5 個月、最新 -1 個月）。
INSERT INTO course_sessions (
  id, course_id, session_date, start_time, end_time, location, capacity, notes, status, created_by
) VALUES
  ('cs-h01', 'course-01', date('now', 'start of month', '-5 month', '+2 day'), '09:00', '12:00', '總公司 A 教室', 20, '歷史場次：新進同仁基礎課程複訓', 'completed', 'usr-admin'),
  ('cs-h02', 'course-02', date('now', 'start of month', '-5 month', '+9 day'), '09:00', '13:00', '總公司 A 教室', 20, '歷史場次：GDP 年度複訓', 'completed', 'usr-admin'),
  ('cs-h03', 'course-03', date('now', 'start of month', '-4 month', '+4 day'), '10:00', '12:00', '線上會議室', 30, '歷史場次：資安年度複訓', 'completed', 'usr-admin'),
  ('cs-h04', 'course-04', date('now', 'start of month', '-3 month', '+7 day'), '13:30', '17:30', '總公司 B 教室', 12, '歷史場次：診所客戶溝通技巧', 'completed', 'usr-admin'),
  ('cs-h05', 'course-05', date('now', 'start of month', '-3 month', '+14 day'), '09:00', '15:00', '總公司 A 教室', 12, '歷史場次：產品知識進階', 'completed', 'usr-admin'),
  ('cs-h06', 'course-07', date('now', 'start of month', '-2 month', '+9 day'), '09:00', '16:00', '總公司 A 教室', 10, '歷史場次：醫院採購與標案實務', 'completed', 'usr-admin'),
  ('cs-h07', 'course-08', date('now', 'start of month', '-1 month', '+11 day'), '09:00', '15:00', '總公司 B 教室', 10, '歷史場次：臨床文獻判讀', 'completed', 'usr-admin');

-- 1-2｜course-01（一階，全員必修）：12 位在職員工皆報名，僅 emp-015 缺席。
WITH roster(employee_id, attendance_status) AS (
  VALUES
    ('emp-001', 'completed'), ('emp-002', 'completed'), ('emp-003', 'completed'),
    ('emp-004', 'completed'), ('emp-005', 'completed'), ('emp-006', 'completed'),
    ('emp-007', 'completed'), ('emp-008', 'completed'), ('emp-010', 'completed'),
    ('emp-012', 'completed'), ('emp-014', 'completed'), ('emp-015', 'absent')
)
INSERT INTO enrollments (
  id, course_session_id, employee_id, source, enrollment_status, attendance_status,
  assigned_at, attended_at, completed_at
)
SELECT
  'enr-cs-h01-' || employee_id, 'cs-h01', employee_id, 'auto', 'enrolled', attendance_status,
  strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', 'start of month', '-5 month')),
  CASE WHEN attendance_status = 'completed'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', 'start of month', '-5 month', '+2 day'))
    ELSE NULL END,
  CASE WHEN attendance_status = 'completed'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', 'start of month', '-5 month', '+2 day'))
    ELSE NULL END
FROM roster;

INSERT INTO training_records (id, employee_id, course_id, course_session_id, enrollment_id, completed_at, hours, valid_until)
SELECT
  'tr-' || en.course_session_id || '-' || en.employee_id, en.employee_id, cs.course_id, cs.id, en.id,
  en.completed_at, c.duration_hours,
  CASE WHEN c.validity_months IS NULL THEN NULL ELSE date(en.completed_at, '+' || c.validity_months || ' months') END
FROM enrollments en
JOIN course_sessions cs ON cs.id = en.course_session_id
JOIN courses c ON c.id = cs.course_id
WHERE en.course_session_id = 'cs-h01' AND en.attendance_status = 'completed';

-- 1-3｜course-02（一階）：emp-014、emp-015 缺席。
WITH roster(employee_id, attendance_status) AS (
  VALUES
    ('emp-001', 'completed'), ('emp-002', 'completed'), ('emp-003', 'completed'),
    ('emp-004', 'completed'), ('emp-005', 'completed'), ('emp-006', 'completed'),
    ('emp-007', 'completed'), ('emp-008', 'completed'), ('emp-010', 'completed'),
    ('emp-012', 'completed'), ('emp-014', 'absent'), ('emp-015', 'absent')
)
INSERT INTO enrollments (
  id, course_session_id, employee_id, source, enrollment_status, attendance_status,
  assigned_at, attended_at, completed_at
)
SELECT
  'enr-cs-h02-' || employee_id, 'cs-h02', employee_id, 'auto', 'enrolled', attendance_status,
  strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', 'start of month', '-5 month')),
  CASE WHEN attendance_status = 'completed'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', 'start of month', '-5 month', '+9 day'))
    ELSE NULL END,
  CASE WHEN attendance_status = 'completed'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', 'start of month', '-5 month', '+9 day'))
    ELSE NULL END
FROM roster;

INSERT INTO training_records (id, employee_id, course_id, course_session_id, enrollment_id, completed_at, hours, valid_until)
SELECT
  'tr-' || en.course_session_id || '-' || en.employee_id, en.employee_id, cs.course_id, cs.id, en.id,
  en.completed_at, c.duration_hours,
  CASE WHEN c.validity_months IS NULL THEN NULL ELSE date(en.completed_at, '+' || c.validity_months || ' months') END
FROM enrollments en
JOIN course_sessions cs ON cs.id = en.course_session_id
JOIN courses c ON c.id = cs.course_id
WHERE en.course_session_id = 'cs-h02' AND en.attendance_status = 'completed';

-- 1-4｜course-03（一階）：emp-010、emp-012 缺席（刻意讓內勤也出現個體差異，
-- 避免內勤部門整體剛好落在 100%）。
WITH roster(employee_id, attendance_status) AS (
  VALUES
    ('emp-001', 'completed'), ('emp-002', 'completed'), ('emp-003', 'completed'),
    ('emp-004', 'completed'), ('emp-005', 'completed'), ('emp-006', 'completed'),
    ('emp-007', 'completed'), ('emp-008', 'completed'), ('emp-010', 'absent'),
    ('emp-012', 'absent'), ('emp-014', 'completed'), ('emp-015', 'completed')
)
INSERT INTO enrollments (
  id, course_session_id, employee_id, source, enrollment_status, attendance_status,
  assigned_at, attended_at, completed_at
)
SELECT
  'enr-cs-h03-' || employee_id, 'cs-h03', employee_id, 'auto', 'enrolled', attendance_status,
  strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', 'start of month', '-4 month')),
  CASE WHEN attendance_status = 'completed'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', 'start of month', '-4 month', '+4 day'))
    ELSE NULL END,
  CASE WHEN attendance_status = 'completed'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', 'start of month', '-4 month', '+4 day'))
    ELSE NULL END
FROM roster;

INSERT INTO training_records (id, employee_id, course_id, course_session_id, enrollment_id, completed_at, hours, valid_until)
SELECT
  'tr-' || en.course_session_id || '-' || en.employee_id, en.employee_id, cs.course_id, cs.id, en.id,
  en.completed_at, c.duration_hours,
  CASE WHEN c.validity_months IS NULL THEN NULL ELSE date(en.completed_at, '+' || c.validity_months || ' months') END
FROM enrollments en
JOIN course_sessions cs ON cs.id = en.course_session_id
JOIN courses c ON c.id = cs.course_id
WHERE en.course_session_id = 'cs-h03' AND en.attendance_status = 'completed';

-- 1-5｜course-04（二階，僅診所線／醫院線必修）：8 人報名，3 人缺席。
WITH roster(employee_id, attendance_status) AS (
  VALUES
    ('emp-002', 'completed'), ('emp-005', 'completed'), ('emp-008', 'completed'), ('emp-014', 'absent'),
    ('emp-003', 'completed'), ('emp-006', 'completed'), ('emp-012', 'absent'), ('emp-015', 'absent')
)
INSERT INTO enrollments (
  id, course_session_id, employee_id, source, enrollment_status, attendance_status,
  assigned_at, attended_at, completed_at
)
SELECT
  'enr-cs-h04-' || employee_id, 'cs-h04', employee_id, 'auto', 'enrolled', attendance_status,
  strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', 'start of month', '-3 month')),
  CASE WHEN attendance_status = 'completed'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', 'start of month', '-3 month', '+7 day'))
    ELSE NULL END,
  CASE WHEN attendance_status = 'completed'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', 'start of month', '-3 month', '+7 day'))
    ELSE NULL END
FROM roster;

INSERT INTO training_records (id, employee_id, course_id, course_session_id, enrollment_id, completed_at, hours, valid_until)
SELECT
  'tr-' || en.course_session_id || '-' || en.employee_id, en.employee_id, cs.course_id, cs.id, en.id,
  en.completed_at, c.duration_hours,
  CASE WHEN c.validity_months IS NULL THEN NULL ELSE date(en.completed_at, '+' || c.validity_months || ' months') END
FROM enrollments en
JOIN course_sessions cs ON cs.id = en.course_session_id
JOIN courses c ON c.id = cs.course_id
WHERE en.course_session_id = 'cs-h04' AND en.attendance_status = 'completed';

-- 1-6｜course-05（二階）：同一批 8 人報名，4 人缺席，完成率再低一階。
WITH roster(employee_id, attendance_status) AS (
  VALUES
    ('emp-002', 'completed'), ('emp-005', 'completed'), ('emp-008', 'absent'), ('emp-014', 'absent'),
    ('emp-003', 'completed'), ('emp-006', 'completed'), ('emp-012', 'absent'), ('emp-015', 'absent')
)
INSERT INTO enrollments (
  id, course_session_id, employee_id, source, enrollment_status, attendance_status,
  assigned_at, attended_at, completed_at
)
SELECT
  'enr-cs-h05-' || employee_id, 'cs-h05', employee_id, 'auto', 'enrolled', attendance_status,
  strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', 'start of month', '-3 month')),
  CASE WHEN attendance_status = 'completed'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', 'start of month', '-3 month', '+14 day'))
    ELSE NULL END,
  CASE WHEN attendance_status = 'completed'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', 'start of month', '-3 month', '+14 day'))
    ELSE NULL END
FROM roster;

INSERT INTO training_records (id, employee_id, course_id, course_session_id, enrollment_id, completed_at, hours, valid_until)
SELECT
  'tr-' || en.course_session_id || '-' || en.employee_id, en.employee_id, cs.course_id, cs.id, en.id,
  en.completed_at, c.duration_hours,
  CASE WHEN c.validity_months IS NULL THEN NULL ELSE date(en.completed_at, '+' || c.validity_months || ' months') END
FROM enrollments en
JOIN course_sessions cs ON cs.id = en.course_session_id
JOIN courses c ON c.id = cs.course_id
WHERE en.course_session_id = 'cs-h05' AND en.attendance_status = 'completed';

-- 1-7｜course-07（三階，僅醫院線必修）：4 人報名，2 人缺席。
WITH roster(employee_id, attendance_status) AS (
  VALUES
    ('emp-003', 'completed'), ('emp-006', 'completed'), ('emp-012', 'absent'), ('emp-015', 'absent')
)
INSERT INTO enrollments (
  id, course_session_id, employee_id, source, enrollment_status, attendance_status,
  assigned_at, attended_at, completed_at
)
SELECT
  'enr-cs-h06-' || employee_id, 'cs-h06', employee_id, 'auto', 'enrolled', attendance_status,
  strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', 'start of month', '-2 month')),
  CASE WHEN attendance_status = 'completed'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', 'start of month', '-2 month', '+9 day'))
    ELSE NULL END,
  CASE WHEN attendance_status = 'completed'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', 'start of month', '-2 month', '+9 day'))
    ELSE NULL END
FROM roster;

INSERT INTO training_records (id, employee_id, course_id, course_session_id, enrollment_id, completed_at, hours, valid_until)
SELECT
  'tr-' || en.course_session_id || '-' || en.employee_id, en.employee_id, cs.course_id, cs.id, en.id,
  en.completed_at, c.duration_hours,
  CASE WHEN c.validity_months IS NULL THEN NULL ELSE date(en.completed_at, '+' || c.validity_months || ' months') END
FROM enrollments en
JOIN course_sessions cs ON cs.id = en.course_session_id
JOIN courses c ON c.id = cs.course_id
WHERE en.course_session_id = 'cs-h06' AND en.attendance_status = 'completed';

-- 1-8｜course-08（三階）：4 人報名，僅 emp-003 完成，醫院線完成率壓到最低。
WITH roster(employee_id, attendance_status) AS (
  VALUES
    ('emp-003', 'completed'), ('emp-006', 'absent'), ('emp-012', 'absent'), ('emp-015', 'absent')
)
INSERT INTO enrollments (
  id, course_session_id, employee_id, source, enrollment_status, attendance_status,
  assigned_at, attended_at, completed_at
)
SELECT
  'enr-cs-h07-' || employee_id, 'cs-h07', employee_id, 'auto', 'enrolled', attendance_status,
  strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', 'start of month', '-1 month')),
  CASE WHEN attendance_status = 'completed'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', 'start of month', '-1 month', '+11 day'))
    ELSE NULL END,
  CASE WHEN attendance_status = 'completed'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', 'start of month', '-1 month', '+11 day'))
    ELSE NULL END
FROM roster;

INSERT INTO training_records (id, employee_id, course_id, course_session_id, enrollment_id, completed_at, hours, valid_until)
SELECT
  'tr-' || en.course_session_id || '-' || en.employee_id, en.employee_id, cs.course_id, cs.id, en.id,
  en.completed_at, c.duration_hours,
  CASE WHEN c.validity_months IS NULL THEN NULL ELSE date(en.completed_at, '+' || c.validity_months || ' months') END
FROM enrollments en
JOIN course_sessions cs ON cs.id = en.course_session_id
JOIN courses c ON c.id = cs.course_id
WHERE en.course_session_id = 'cs-h07' AND en.attendance_status = 'completed';

-- ---------------------------------------------------------------------------
-- 二、歷史招募時間軸
-- ---------------------------------------------------------------------------
-- 0003 的 4 位種子候選人透過 0005 遷移為 candidate_applications 時，
-- applied_at 沿用 candidates.created_at（即套用 migration 當下），四筆全部
-- 落在同一個瞬間，漏斗一旦篩選非當月期間就必然是空的。此處將四筆投遞時間
-- 分散到最近 5 個月，涵蓋目前四種不同階段（applied／screening／interview／
-- offer），確保各階段 enteredCount 呈現正常的「越後面的階段人數越少」。
--
-- 只調整 applied_at 還不夠：candidate_application_status_history.changed_at
-- 是 0006 依「applied_at + ord * 2 天」回填的，若不連動更新，階段歷程會停留
-- 在舊的（等於 migration 當下的）時間點，變成「還沒投遞就已進入後續階段」的
-- 矛盾資料。故下方用同一組 stage_order／公式重算 changed_at，並讓
-- updated_at 對齊該應徵目前狀態的最後一次歷程時間，維持三者一致。

UPDATE candidate_applications
SET applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', 'start of month', '-1 month', '+9 day'))
WHERE id = 'app-cand-01';

UPDATE candidate_applications
SET applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', 'start of month', '-2 month', '+14 day'))
WHERE id = 'app-cand-04';

UPDATE candidate_applications
SET applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', 'start of month', '-4 month', '+6 day'))
WHERE id = 'app-cand-02';

UPDATE candidate_applications
SET applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', 'start of month', '-5 month', '+3 day'))
WHERE id = 'app-cand-03';

-- 沿用 0006 的階段序表與公式（見 0006 §一），依新的 applied_at 重算每一列
-- 階段歷程的 changed_at。
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
UPDATE candidate_application_status_history
SET changed_at = (
  SELECT MIN(
    strftime('%Y-%m-%dT%H:%M:%fZ', datetime(ca.applied_at, '+' || (so.ord * 2) || ' days')),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  FROM candidate_applications ca
  JOIN stage_order so ON so.stage = candidate_application_status_history.to_status
  WHERE ca.id = candidate_application_status_history.application_id
)
WHERE application_id IN ('app-cand-01', 'app-cand-02', 'app-cand-03', 'app-cand-04');

UPDATE candidate_applications
SET updated_at = (
  SELECT MAX(h.changed_at) FROM candidate_application_status_history h
  WHERE h.application_id = candidate_applications.id
)
WHERE id IN ('app-cand-01', 'app-cand-02', 'app-cand-03', 'app-cand-04');
