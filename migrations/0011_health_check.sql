-- 0011：員工健康檢查追蹤（人資新增需求，原規格未涵蓋）。
--
-- 需求重點：
--   1. 記錄員工是否健檢、做了哪些項目、追蹤頻率、提前提醒。
--   2. 健檢頻率依台灣《勞工健康保護規則》的年齡分級自動計算，不由使用者輸入：
--        未滿 40 歲       → 每 5 年（60 個月）
--        40 歲以上未滿 65 → 每 3 年（36 個月）
--        65 歲以上        → 每 1 年（12 個月）
--      年齡以「今日」計算足歲，因此同一位員工跨過 40／65 生日後，間隔會自動縮短。
--      這是 on-read 計算（見 src/server/health.ts），資料庫不存 next_due_date，
--      避免員工生日一到就要跑排程回填。
--   3. 健檢紀錄屬個資法第 6 條特種個資，僅 admin 與本人可讀（權限做在 SQL 層）。

-- ---------------------------------------------------------------------------
-- 一、employees.birth_date
-- ---------------------------------------------------------------------------
-- 可為 NULL：既有資料未必有生日，且 0001 建表時沒有這一欄。
-- 沒有生日就算不出年齡分級，後端會明確標為「需補資料」而非套用預設間隔
-- （見 src/server/health.ts 的 missing_birth_date 狀態）。
ALTER TABLE employees ADD COLUMN birth_date TEXT;

-- 為既有 15 位員工補生日。
-- 一律用相對日期（date('now', '-N year', '-M day')），確保任何時間套用 seed，
-- 三個年齡級距的分佈都不變；額外再退 N 天是為了讓「今年的生日已經過了」，
-- 避免剛好落在生日當天／閏日（2/29 會被 SQLite 正規化成 3/1）而算出少一歲。
-- 刻意不用一長串 UNION ALL（0006 踩過 D1 的 too many terms in compound SELECT），
-- 直接拆成 15 個 UPDATE，最單純也最不會踩雷。
--
-- 級距分佈（含離職者；0007 已將 emp-009／emp-011／emp-013 標為 inactive）：
--   未滿 40：emp-004(33) emp-008(28) emp-010(36) emp-013(25) emp-014(30) emp-015(27)
--   40–65  ：emp-001(48) emp-002(45) emp-005(42) emp-007(52) emp-011(58)
--   65 以上：emp-003(66) emp-006(70) emp-009(68) emp-012(67)
-- 只看在職者也仍然每個級距至少 2 人（未滿 40 五人／40–65 四人／65 以上三人）。
UPDATE employees SET birth_date = date('now', '-48 year', '-120 day') WHERE id = 'emp-001';
UPDATE employees SET birth_date = date('now', '-45 year', '-201 day') WHERE id = 'emp-002';
UPDATE employees SET birth_date = date('now', '-66 year', '-64 day')  WHERE id = 'emp-003';
UPDATE employees SET birth_date = date('now', '-33 year', '-158 day') WHERE id = 'emp-004';
UPDATE employees SET birth_date = date('now', '-42 year', '-95 day')  WHERE id = 'emp-005';
UPDATE employees SET birth_date = date('now', '-70 year', '-233 day') WHERE id = 'emp-006';
UPDATE employees SET birth_date = date('now', '-52 year', '-77 day')  WHERE id = 'emp-007';
UPDATE employees SET birth_date = date('now', '-28 year', '-142 day') WHERE id = 'emp-008';
UPDATE employees SET birth_date = date('now', '-68 year', '-188 day') WHERE id = 'emp-009';
UPDATE employees SET birth_date = date('now', '-36 year', '-51 day')  WHERE id = 'emp-010';
UPDATE employees SET birth_date = date('now', '-58 year', '-171 day') WHERE id = 'emp-011';
UPDATE employees SET birth_date = date('now', '-67 year', '-109 day') WHERE id = 'emp-012';
UPDATE employees SET birth_date = date('now', '-25 year', '-224 day') WHERE id = 'emp-013';
UPDATE employees SET birth_date = date('now', '-30 year', '-133 day') WHERE id = 'emp-014';
UPDATE employees SET birth_date = date('now', '-27 year', '-86 day')  WHERE id = 'emp-015';

-- ---------------------------------------------------------------------------
-- 二、健檢項目主檔
-- ---------------------------------------------------------------------------
-- 模式沿用到職文件主檔 onboarding_items（0001:249）：name UNIQUE、required、active，
-- 停用改 active = 0 而非刪列，已引用該項目的歷史紀錄才不會斷。
-- 另加 category（分類，純顯示用）與 sort_order（同分類內的固定排序）。
CREATE TABLE health_check_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT '',
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- 三、健檢紀錄（每位員工每次健檢一列）
-- ---------------------------------------------------------------------------
-- UNIQUE (employee_id, check_date)：同一員工同一天不會有兩次健檢，
-- 重複建立回 409，避免匯入／重複送出造成「最後一次健檢日」失真。
-- ON DELETE CASCADE：員工被刪除時健檢紀錄一併消失（特種個資不留孤兒列）。
CREATE TABLE health_checks (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  check_date TEXT NOT NULL,
  institution TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (employee_id, check_date)
);

-- ---------------------------------------------------------------------------
-- 四、某次健檢做了哪些項目（關聯表 + 逐項結果／備註）
-- ---------------------------------------------------------------------------
-- 「有列 = 這次有做這個項目」，因此不需要另設 done 旗標。
-- result 用受限列舉而非自由文字，前端才好上色；細節放 notes。
CREATE TABLE health_check_results (
  id TEXT PRIMARY KEY,
  health_check_id TEXT NOT NULL REFERENCES health_checks(id) ON DELETE CASCADE,
  health_check_item_id TEXT NOT NULL REFERENCES health_check_items(id),
  result TEXT NOT NULL DEFAULT 'pending'
    CHECK (result IN ('normal', 'abnormal', 'follow_up', 'pending')),
  notes TEXT NOT NULL DEFAULT '',
  UNIQUE (health_check_id, health_check_item_id)
);

-- ---------------------------------------------------------------------------
-- 五、設定值
-- ---------------------------------------------------------------------------
-- 提前幾個月提醒。限制 1～3（驗證在 src/server/settings.ts 與 health.ts），預設 2。
INSERT OR IGNORE INTO settings (setting_key, setting_value, value_type, description)
VALUES ('health_check_reminder_months', '2', 'number', '健康檢查到期提前提醒月數（1～3）');

-- ---------------------------------------------------------------------------
-- 六、種子資料：健檢項目
-- ---------------------------------------------------------------------------
INSERT INTO health_check_items (id, name, category, required, active, sort_order) VALUES
  ('hci-xray',        '胸部 X 光攝影',              '影像檢查',   1, 1, 10),
  ('hci-bp',          '血壓量測',                   '一般理學',   1, 1, 20),
  ('hci-glucose',     '血糖檢查',                   '血液生化',   1, 1, 30),
  ('hci-liver',       '肝功能檢查（GOT／GPT）',     '血液生化',   1, 1, 40),
  ('hci-kidney',      '腎功能檢查（肌酸酐）',       '血液生化',   1, 1, 50),
  ('hci-lipid',       '血脂檢查（膽固醇／三酸甘油酯）', '血液生化', 0, 1, 60),
  ('hci-vision',      '視力檢查',                   '一般理學',   1, 1, 70),
  ('hci-hearing',     '聽力檢查',                   '一般理學',   0, 1, 80);

-- ---------------------------------------------------------------------------
-- 七、種子資料：健檢紀錄
-- ---------------------------------------------------------------------------
-- 目的是讓 GET /api/admin/health-checks/due 的四種狀態都出現，否則篩選功能等於沒驗到。
-- 全部用相對日期，套用時間不影響結論。狀態門檻以預設 reminderMonths = 2 計算：
--
--   emp-001 48歲/36個月  最後 -40 月 → 應檢日 -4 月   → overdue
--   emp-003 66歲/12個月  最後 -20 月 → 應檢日 -8 月   → overdue（另有一筆 -38 月的舊紀錄，驗證取 MAX）
--   emp-006 70歲/12個月  最後 -14 月 → 應檢日 -2 月   → overdue
--   emp-002 45歲/36個月  最後 -35 月 → 應檢日 +1 月   → due_soon
--   emp-012 67歲/12個月  最後 -11 月又 -15 天 → 約 +15 天 → due_soon
--   emp-005 42歲/36個月  最後 -10 月 → 應檢日 +26 月  → ok
--   emp-004 33歲/60個月  最後 -6 月  → 應檢日 +54 月  → ok
--   emp-007 52歲/36個月  無紀錄，到職 2022-04-18 → 基準日 2025-04-18（已過）→ never（預設視窗即可見）
--   emp-008／emp-010／emp-014／emp-015 無紀錄且到職日較晚 → never，但要放大 ?months= 才看得到
--
-- （emp-009／emp-011／emp-013 於 0007 已離職，/due 只看在職者，故不列入。）
INSERT INTO health_checks (id, employee_id, check_date, institution, notes) VALUES
  ('hc-001-a', 'emp-001', date('now', '-40 month'),             '台北市立聯合醫院', '一般健康檢查'),
  ('hc-002-a', 'emp-002', date('now', '-35 month'),             '國泰健康管理中心', '一般健康檢查'),
  ('hc-003-a', 'emp-003', date('now', '-38 month'),             '台北市立聯合醫院', '前次健檢'),
  ('hc-003-b', 'emp-003', date('now', '-20 month'),             '台北市立聯合醫院', '高齡員工年度健檢'),
  ('hc-004-a', 'emp-004', date('now', '-6 month'),              '聯安預防醫學機構', '一般健康檢查'),
  ('hc-005-a', 'emp-005', date('now', '-10 month'),             '國泰健康管理中心', '一般健康檢查'),
  ('hc-006-a', 'emp-006', date('now', '-14 month'),             '台北榮民總醫院',   '高齡員工年度健檢'),
  ('hc-012-a', 'emp-012', date('now', '-11 month', '-15 day'),  '台北榮民總醫院',   '高齡員工年度健檢');

-- 逐項結果。刻意讓不同紀錄勾選不同項目，驗證「每次健檢勾選做了哪些」而非固定全套；
-- 也放入 abnormal／follow_up，讓前端的結果標示有資料可呈現。
INSERT INTO health_check_results (id, health_check_id, health_check_item_id, result, notes) VALUES
  ('hcr-001-a-1', 'hc-001-a', 'hci-xray',    'normal',    ''),
  ('hcr-001-a-2', 'hc-001-a', 'hci-bp',      'normal',    ''),
  ('hcr-001-a-3', 'hc-001-a', 'hci-glucose', 'normal',    ''),
  ('hcr-002-a-1', 'hc-002-a', 'hci-xray',    'normal',    ''),
  ('hcr-002-a-2', 'hc-002-a', 'hci-bp',      'abnormal',  '收縮壓偏高，建議追蹤'),
  ('hcr-002-a-3', 'hc-002-a', 'hci-liver',   'normal',    ''),
  ('hcr-002-a-4', 'hc-002-a', 'hci-vision',  'normal',    '');

INSERT INTO health_check_results (id, health_check_id, health_check_item_id, result, notes) VALUES
  ('hcr-003-a-1', 'hc-003-a', 'hci-xray',    'normal',    ''),
  ('hcr-003-a-2', 'hc-003-a', 'hci-bp',      'normal',    ''),
  ('hcr-003-b-1', 'hc-003-b', 'hci-xray',    'normal',    ''),
  ('hcr-003-b-2', 'hc-003-b', 'hci-bp',      'follow_up', '需三個月後複檢'),
  ('hcr-003-b-3', 'hc-003-b', 'hci-kidney',  'normal',    ''),
  ('hcr-003-b-4', 'hc-003-b', 'hci-hearing', 'abnormal',  '高頻聽力下降'),
  ('hcr-004-a-1', 'hc-004-a', 'hci-xray',    'normal',    ''),
  ('hcr-004-a-2', 'hc-004-a', 'hci-glucose', 'normal',    '');

INSERT INTO health_check_results (id, health_check_id, health_check_item_id, result, notes) VALUES
  ('hcr-005-a-1', 'hc-005-a', 'hci-bp',      'normal',    ''),
  ('hcr-005-a-2', 'hc-005-a', 'hci-lipid',   'follow_up', '總膽固醇 215 mg/dL'),
  ('hcr-006-a-1', 'hc-006-a', 'hci-xray',    'normal',    ''),
  ('hcr-006-a-2', 'hc-006-a', 'hci-bp',      'normal',    ''),
  ('hcr-006-a-3', 'hc-006-a', 'hci-kidney',  'follow_up', 'eGFR 偏低'),
  ('hcr-012-a-1', 'hc-012-a', 'hci-xray',    'normal',    ''),
  ('hcr-012-a-2', 'hc-012-a', 'hci-bp',      'normal',    ''),
  ('hcr-012-a-3', 'hc-012-a', 'hci-vision',  'normal',    '');

-- ---------------------------------------------------------------------------
-- 八、索引
-- ---------------------------------------------------------------------------
-- /due 與員工端都以 employee_id 取「最後一次健檢日」，check_date 倒序可直接取首列。
CREATE INDEX idx_health_checks_employee_date ON health_checks(employee_id, check_date DESC);
CREATE INDEX idx_health_check_results_check ON health_check_results(health_check_id);
CREATE INDEX idx_health_check_results_item ON health_check_results(health_check_item_id);
