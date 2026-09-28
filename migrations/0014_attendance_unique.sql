-- Enforce the documented one-row-per-employee-per-day attendance invariant.
-- To inspect pre-existing collisions without modifying any attendance rows:
-- SELECT employee_id, attendance_date, COUNT(*) AS row_count,
--        group_concat(id, ',') AS record_ids
-- FROM attendance
-- GROUP BY employee_id, attendance_date
-- HAVING COUNT(*) > 1
-- ORDER BY employee_id, attendance_date;
-- Deliberately no cleanup: CREATE UNIQUE INDEX fails safely if duplicates exist.
CREATE UNIQUE INDEX idx_attendance_employee_date_unique
  ON attendance(employee_id, attendance_date);
