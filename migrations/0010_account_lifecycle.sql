-- 0010：登入帳號生命週期管理——封存（匿名化）標記欄位。
--
-- 背景：DELETE /api/admin/users/{id} 由系統自行判斷刪除方式。
--   * 無稽核關聯（course_sessions.created_by／special_days.created_by／
--     conflict_overrides.overridden_by／candidate_application_status_history.changed_by／
--     audit_logs.actor_user_id／enrollments.reviewed_by／salary_approvals.approved_by）
--     → 實體刪除 users 列。
--   * 有稽核關聯 → 不能刪列（刪了稽核軌跡會斷、且 NOT NULL 外鍵會直接擋下），
--     改為「封存」：保留 id 與整列，但把 email 匿名化、密碼換成無法通過驗證的隨機值、
--     active = 0、並刪除其 sessions。
--
-- 這兩欄就是封存所需的最小狀態：
--   archived_at           非 NULL 即代表此列已封存。清單／查詢一律排除，
--                         使封存帳號在管理介面上等同已刪除。
--   archived_employee_id  封存時 users.employee_id 必須設回 NULL，否則 UNIQUE 約束
--                         會擋住「同一員工日後重新建立帳號」。原本掛在哪位員工身上
--                         改記在這裡，稽核追查時仍查得到。
--                         刻意不加 REFERENCES employees(id)：這是歷史快照，
--                         不應反過來限制員工主檔，也避免 ALTER TABLE 加外鍵的限制。

ALTER TABLE users ADD COLUMN archived_at TEXT;
ALTER TABLE users ADD COLUMN archived_employee_id TEXT;

-- 清單查詢固定帶 archived_at IS NULL，且封存屬少數，用部分索引即可。
CREATE INDEX idx_users_active_not_archived ON users(archived_at, active);
