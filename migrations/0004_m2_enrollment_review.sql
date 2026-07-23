ALTER TABLE enrollments ADD COLUMN reviewed_by TEXT REFERENCES users(id);
ALTER TABLE enrollments ADD COLUMN reviewed_at TEXT;
ALTER TABLE enrollments ADD COLUMN review_note TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_enrollments_review_queue
ON enrollments(source, enrollment_status, assigned_at);
