CREATE INDEX idx_employees_job_type ON employees(job_type_id, status);
CREATE INDEX idx_employees_department ON employees(department, status);
CREATE INDEX idx_sessions_token ON sessions(token_hash, expires_at);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_courses_level_type ON courses(competency_level, course_type, active);
CREATE INDEX idx_course_sessions_date_time ON course_sessions(session_date, start_time, end_time);
CREATE INDEX idx_course_sessions_course ON course_sessions(course_id);
CREATE INDEX idx_enrollments_employee ON enrollments(employee_id, enrollment_status);
CREATE INDEX idx_enrollments_session ON enrollments(course_session_id, enrollment_status);
CREATE INDEX idx_training_records_employee_course ON training_records(employee_id, course_id);
CREATE INDEX idx_special_days_date_type ON special_days(special_date, day_type);
CREATE INDEX idx_employee_certifications_expiry ON employee_certifications(employee_id, expires_at);
CREATE INDEX idx_attendance_date_department ON attendance(attendance_date, employee_id);
CREATE INDEX idx_candidates_opening_status ON candidates(job_opening_id, status);
CREATE INDEX idx_candidate_history_candidate ON candidate_status_history(candidate_id, changed_at);
CREATE INDEX idx_interviews_candidate ON interviews(candidate_id, scheduled_at);
CREATE INDEX idx_probations_due ON probations(due_date, result);
CREATE INDEX idx_idp_employee_status ON idp_plans(employee_id, status);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id, created_at);

CREATE TRIGGER users_updated_at
AFTER UPDATE ON users
FOR EACH ROW
BEGIN
  UPDATE users SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER employees_updated_at
AFTER UPDATE ON employees
FOR EACH ROW
BEGIN
  UPDATE employees SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER courses_updated_at
AFTER UPDATE ON courses
FOR EACH ROW
BEGIN
  UPDATE courses SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER course_sessions_updated_at
AFTER UPDATE ON course_sessions
FOR EACH ROW
BEGIN
  UPDATE course_sessions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
