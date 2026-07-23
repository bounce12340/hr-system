INSERT INTO job_types (id, name, required_level) VALUES
  ('jt-office', '內勤', 1),
  ('jt-clinic', '診所線', 2),
  ('jt-hospital', '醫院線', 3);

INSERT INTO employees (id, employee_no, name, email, department, grade, title, job_type_id, hire_date, status, salary) VALUES
  ('emp-001', 'E001', '王怡文', 'yiwen.wang@demo.local', '人資行政部', 'G6', '人資經理', 'jt-office', '2020-03-02', 'active', 72000),
  ('emp-002', 'E002', '林家豪', 'chiahao.lin@demo.local', '診所事業部', 'G5', '資深業務代表', 'jt-clinic', '2021-05-10', 'active', 65000),
  ('emp-003', 'E003', '陳雅婷', 'yating.chen@demo.local', '醫院事業部', 'G5', '資深業務代表', 'jt-hospital', '2021-08-16', 'active', 68000),
  ('emp-004', 'E004', '張志明', 'chihming.chang@demo.local', '人資行政部', 'G3', '行政專員', 'jt-office', '2023-02-01', 'active', 42000),
  ('emp-005', 'E005', '李佩珊', 'peishan.li@demo.local', '診所事業部', 'G4', '業務代表', 'jt-clinic', '2022-09-12', 'active', 54000),
  ('emp-006', 'E006', '黃冠宇', 'kuanyu.huang@demo.local', '醫院事業部', 'G4', '業務代表', 'jt-hospital', '2022-11-07', 'active', 56000),
  ('emp-007', 'E007', '吳佳蓉', 'jiarong.wu@demo.local', '人資行政部', 'G4', '會計專員', 'jt-office', '2022-04-18', 'active', 50000),
  ('emp-008', 'E008', '劉俊傑', 'chunchieh.liu@demo.local', '診所事業部', 'G3', '業務代表', 'jt-clinic', '2024-01-08', 'active', 48000),
  ('emp-009', 'E009', '蔡依庭', 'yiting.tsai@demo.local', '醫院事業部', 'G3', '業務代表', 'jt-hospital', '2024-02-19', 'active', 49000),
  ('emp-010', 'E010', '楊博翔', 'poshiang.yang@demo.local', '人資行政部', 'G3', '資訊專員', 'jt-office', '2023-07-03', 'active', 52000),
  ('emp-011', 'E011', '許心怡', 'hsinyi.hsu@demo.local', '診所事業部', 'G4', '產品專員', 'jt-clinic', '2022-06-13', 'active', 55000),
  ('emp-012', 'E012', '鄭凱文', 'kaiwen.cheng@demo.local', '醫院事業部', 'G4', '產品專員', 'jt-hospital', '2022-10-17', 'active', 58000),
  ('emp-013', 'E013', '謝雨潔', 'yuchieh.hsieh@demo.local', '人資行政部', 'G2', '行政助理', 'jt-office', '2025-03-03', 'active', 38000),
  ('emp-014', 'E014', '周承恩', 'chengen.chou@demo.local', '診所事業部', 'G2', '業務助理', 'jt-clinic', '2025-05-05', 'active', 40000),
  ('emp-015', 'E015', '郭采薇', 'tsaiwei.kuo@demo.local', '醫院事業部', 'G2', '業務助理', 'jt-hospital', '2025-06-02', 'active', 41000);

INSERT INTO users (id, employee_id, email, password_hash, password_salt, password_iterations, role, must_change_password) VALUES
  ('usr-admin', 'emp-001', 'admin@demo.local', 'OM99pzk617FqsBX/WzmejkXvfVvCxgyD6bsoa/1uriY=', 'YWRtaW4tZGVtby1zYWx0LTIwMjY=', 100000, 'admin', 1),
  ('usr-002', 'emp-002', 'chiahao.lin@demo.local', 'Y2rFbbhE7z1jx6GAZ1HTTfL5b4/J1pq06dgX9DvrZaY=', 'ZW1wbG95ZWUtZGVtby1zYWx0LTIwMjY=', 100000, 'employee', 1),
  ('usr-003', 'emp-003', 'yating.chen@demo.local', 'Y2rFbbhE7z1jx6GAZ1HTTfL5b4/J1pq06dgX9DvrZaY=', 'ZW1wbG95ZWUtZGVtby1zYWx0LTIwMjY=', 100000, 'employee', 1),
  ('usr-004', 'emp-004', 'chihming.chang@demo.local', 'Y2rFbbhE7z1jx6GAZ1HTTfL5b4/J1pq06dgX9DvrZaY=', 'ZW1wbG95ZWUtZGVtby1zYWx0LTIwMjY=', 100000, 'employee', 1),
  ('usr-005', 'emp-005', 'peishan.li@demo.local', 'Y2rFbbhE7z1jx6GAZ1HTTfL5b4/J1pq06dgX9DvrZaY=', 'ZW1wbG95ZWUtZGVtby1zYWx0LTIwMjY=', 100000, 'employee', 1),
  ('usr-006', 'emp-006', 'kuanyu.huang@demo.local', 'Y2rFbbhE7z1jx6GAZ1HTTfL5b4/J1pq06dgX9DvrZaY=', 'ZW1wbG95ZWUtZGVtby1zYWx0LTIwMjY=', 100000, 'employee', 1),
  ('usr-007', 'emp-007', 'jiarong.wu@demo.local', 'Y2rFbbhE7z1jx6GAZ1HTTfL5b4/J1pq06dgX9DvrZaY=', 'ZW1wbG95ZWUtZGVtby1zYWx0LTIwMjY=', 100000, 'employee', 1),
  ('usr-008', 'emp-008', 'chunchieh.liu@demo.local', 'Y2rFbbhE7z1jx6GAZ1HTTfL5b4/J1pq06dgX9DvrZaY=', 'ZW1wbG95ZWUtZGVtby1zYWx0LTIwMjY=', 100000, 'employee', 1),
  ('usr-009', 'emp-009', 'yiting.tsai@demo.local', 'Y2rFbbhE7z1jx6GAZ1HTTfL5b4/J1pq06dgX9DvrZaY=', 'ZW1wbG95ZWUtZGVtby1zYWx0LTIwMjY=', 100000, 'employee', 1),
  ('usr-010', 'emp-010', 'poshiang.yang@demo.local', 'Y2rFbbhE7z1jx6GAZ1HTTfL5b4/J1pq06dgX9DvrZaY=', 'ZW1wbG95ZWUtZGVtby1zYWx0LTIwMjY=', 100000, 'employee', 1),
  ('usr-011', 'emp-011', 'hsinyi.hsu@demo.local', 'Y2rFbbhE7z1jx6GAZ1HTTfL5b4/J1pq06dgX9DvrZaY=', 'ZW1wbG95ZWUtZGVtby1zYWx0LTIwMjY=', 100000, 'employee', 1),
  ('usr-012', 'emp-012', 'kaiwen.cheng@demo.local', 'Y2rFbbhE7z1jx6GAZ1HTTfL5b4/J1pq06dgX9DvrZaY=', 'ZW1wbG95ZWUtZGVtby1zYWx0LTIwMjY=', 100000, 'employee', 1),
  ('usr-013', 'emp-013', 'yuchieh.hsieh@demo.local', 'Y2rFbbhE7z1jx6GAZ1HTTfL5b4/J1pq06dgX9DvrZaY=', 'ZW1wbG95ZWUtZGVtby1zYWx0LTIwMjY=', 100000, 'employee', 1),
  ('usr-014', 'emp-014', 'chengen.chou@demo.local', 'Y2rFbbhE7z1jx6GAZ1HTTfL5b4/J1pq06dgX9DvrZaY=', 'ZW1wbG95ZWUtZGVtby1zYWx0LTIwMjY=', 100000, 'employee', 1),
  ('usr-015', 'emp-015', 'tsaiwei.kuo@demo.local', 'Y2rFbbhE7z1jx6GAZ1HTTfL5b4/J1pq06dgX9DvrZaY=', 'ZW1wbG95ZWUtZGVtby1zYWx0LTIwMjY=', 100000, 'employee', 1);

INSERT INTO certifications (id, name, issuer, default_validity_months) VALUES
  ('cert-gdp', 'GDP 藥品優良運銷規範', '衛生福利部', 24),
  ('cert-product', '產品專業認證', '公司內部', 12),
  ('cert-hospital', '醫院通路合規認證', '公司內部', 12);

INSERT INTO courses (id, name, competency_level, course_type, duration_hours, instructor, description, related_certification_id, validity_months, enrollment_open) VALUES
  ('course-01', '公司文化與法規基礎', 1, 'mandatory', 3, '王怡文', '新進同仁共同基礎課程。', NULL, 12, 0),
  ('course-02', '藥品安全與 GDP 基礎', 1, 'mandatory', 4, '外聘講師', '藥品儲運與安全規範。', 'cert-gdp', 24, 0),
  ('course-03', '資訊安全與個資保護', 1, 'mandatory', 2, '楊博翔', '資訊安全與個資法實務。', NULL, 12, 0),
  ('course-04', '診所客戶溝通技巧', 2, 'mandatory', 4, '林家豪', '診所通路拜訪與需求探索。', NULL, 12, 0),
  ('course-05', '產品知識進階', 2, 'mandatory', 6, '許心怡', '核心產品適應症與競品分析。', 'cert-product', 12, 0),
  ('course-06', '簡報與說服力工作坊', 2, 'elective', 3, '外聘講師', '實作型簡報表達訓練。', NULL, NULL, 1),
  ('course-07', '醫院採購與標案實務', 3, 'mandatory', 6, '陳雅婷', '醫院採購流程、標案及合規。', 'cert-hospital', 12, 0),
  ('course-08', '臨床文獻判讀', 3, 'mandatory', 6, '外聘藥師', '臨床研究設計與文獻判讀。', NULL, 12, 0),
  ('course-09', '時間管理工作坊', 1, 'elective', 2, '外聘講師', '任務排序與時間管理。', NULL, NULL, 1);

INSERT INTO course_sessions (id, course_id, session_date, start_time, end_time, location, capacity, notes, created_by) VALUES
  ('cs-01', 'course-01', date('now', '+5 day'), '09:00', '12:00', '總公司 A 教室', 20, '新進同仁優先', 'usr-admin'),
  ('cs-02', 'course-04', date('now', '+9 day'), '13:30', '17:30', '總公司 B 教室', 12, '', 'usr-admin'),
  ('cs-03', 'course-06', date('now', '+12 day'), '09:00', '12:00', '線上會議室', 8, '開放自行報名', 'usr-admin'),
  ('cs-04', 'course-07', date('now', '+18 day'), '09:00', '16:00', '總公司 A 教室', 10, '', 'usr-admin'),
  ('cs-05', 'course-09', date('now', '+22 day'), '14:00', '16:00', '總公司 B 教室', 10, '開放自行報名', 'usr-admin'),
  ('cs-06', 'course-03', date('now', '+26 day'), '10:00', '12:00', '線上會議室', 30, '全員年度必訓', 'usr-admin');

INSERT INTO special_days (id, special_date, day_type, title, reason, course_session_id, created_by) VALUES
  ('sd-blackout', date('now', '+15 day'), 'blackout', '全公司年度盤點', '全員支援年度盤點，禁止排課。', NULL, 'usr-admin'),
  ('sd-all', date('now', '+26 day'), 'mandatory_all', '資訊安全全員必訓日', '全體在職員工均須參加。', 'cs-06', 'usr-admin');

INSERT INTO enrollments (id, course_session_id, employee_id, source)
SELECT 'enr-cs01-' || id, 'cs-01', id, 'auto' FROM employees WHERE status = 'active';

INSERT INTO enrollments (id, course_session_id, employee_id, source)
SELECT 'enr-cs02-' || e.id, 'cs-02', e.id, 'auto'
FROM employees e JOIN job_types jt ON jt.id = e.job_type_id
WHERE e.status = 'active' AND jt.required_level >= 2;

INSERT INTO enrollments (id, course_session_id, employee_id, source)
SELECT 'enr-cs04-' || e.id, 'cs-04', e.id, 'auto'
FROM employees e JOIN job_types jt ON jt.id = e.job_type_id
WHERE e.status = 'active' AND jt.required_level >= 3;

INSERT INTO enrollments (id, course_session_id, employee_id, source)
SELECT 'enr-cs06-' || id, 'cs-06', id, 'auto' FROM employees WHERE status = 'active';

INSERT INTO employee_certifications (id, employee_id, certification_id, certificate_number, issued_at, expires_at, notes) VALUES
  ('ec-01', 'emp-002', 'cert-gdp', 'GDP-2025-1002', date('now', '-330 day'), date('now', '+25 day'), '30 天內到期示範'),
  ('ec-02', 'emp-003', 'cert-hospital', 'HSP-2026-0003', date('now', '-90 day'), date('now', '+275 day'), ''),
  ('ec-03', 'emp-005', 'cert-product', 'PRD-2026-0005', date('now', '-60 day'), date('now', '+305 day'), '');

INSERT INTO job_openings (id, title, department, headcount, description, status) VALUES
  ('job-01', '診所線業務代表', '診所事業部', 2, '負責北區診所客戶開發與維護。', 'open'),
  ('job-02', '產品專員', '醫院事業部', 1, '負責產品訓練與臨床資料支援。', 'open');

INSERT INTO candidates (id, name, email, phone, source, job_opening_id, notes, status) VALUES
  ('cand-01', '蘇柏宇', 'boyu.su@example.com', '0912000001', '104 人力銀行', 'job-01', '', 'applied'),
  ('cand-02', '何欣蓉', 'hsinrong.ho@example.com', '0912000002', '員工推薦', 'job-01', '', 'interview'),
  ('cand-03', '彭思妤', 'ssuyu.peng@example.com', '0912000003', 'LinkedIn', 'job-02', '', 'offer'),
  ('cand-04', '羅威廷', 'weiting.lo@example.com', '0912000004', '公司官網', 'job-02', '', 'screening');

INSERT INTO onboarding_items (id, name, required) VALUES
  ('obi-01', '身分證影本', 1),
  ('obi-02', '體檢報告', 1),
  ('obi-03', '保證書', 1),
  ('obi-04', '薪轉帳戶資料', 1);

INSERT INTO settings (setting_key, setting_value, value_type, description) VALUES
  ('timezone', 'Asia/Taipei', 'string', '系統顯示時區'),
  ('certification_reminder_days', '60', 'number', '證照到期提醒天數'),
  ('elective_enrollment_requires_approval', 'false', 'boolean', '選修課是否需 admin 審核'),
  ('custom_domain', 'hr.example.com', 'string', '預設自訂網域');
