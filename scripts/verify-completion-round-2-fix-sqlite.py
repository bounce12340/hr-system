"""Supplemental SQLite probe for the round-2 date and legacy fixes.

This is isolated SQLite only. It is not Vitest, Cloudflare D1, browser, staging,
or production evidence. SQL is copied from the conversion batch for this probe;
it does not prove the TypeScript file was executed.
"""
import datetime
import pathlib
import sqlite3

root = pathlib.Path(__file__).resolve().parents[1]
source = (root / "src/server/onboarding-conversion.ts").read_text()
assert "export function strictIsoDate" in source
executable = "\n".join(line for line in source.splitlines() if not line.strip().startswith("*") and "Date.parse accepts overflow" not in line)
assert "Date.parse(" not in executable
m3 = (root / "src/server/m3.ts").read_text()
assert 'target === "onboarded"' in m3

def calendar_date(value):
    year, month, day = (int(part) for part in value.split("-"))
    parsed = datetime.date(year, month, day)
    return parsed.isoformat() == value

for invalid in ("2026-02-30", "2026-02-31", "2026-04-31", "2026-13-01", "2023-02-29"):
    try:
        accepted = calendar_date(invalid)
    except ValueError:
        continue
    if accepted:
        raise AssertionError(f"overflow date accepted: {invalid}")
assert calendar_date("2024-02-29")
assert calendar_date("2026-09-28")
print("PASS: calendar dates reject overflow and accept leap day")

db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys = ON")
for migration in sorted((root / "migrations").glob("*.sql")):
    db.executescript(migration.read_text())
job_type = db.execute("SELECT id FROM job_types WHERE active = 1 LIMIT 1").fetchone()[0]
db.execute("INSERT INTO job_openings(id,title,department,headcount,description,status) VALUES ('probe-job','probe','測試部',1,'probe','open')")
db.execute("INSERT INTO candidates(id,name,email,source,status) VALUES ('probe-candidate','探針','probe@example.com','probe','hired')")
db.execute("INSERT INTO candidate_applications(id,candidate_id,job_opening_id,status) VALUES ('probe-app','probe-candidate','probe-job','hired')")
for row in db.execute("SELECT id FROM onboarding_items WHERE active = 1 AND required = 1"):
    db.execute(
        "INSERT INTO application_onboarding_checklist(id,application_id,onboarding_item_id,completed) VALUES (?, 'probe-app', ?, 1)",
        (f"probe-check-{row[0]}", row[0]),
    )

statements = [
    """INSERT INTO employees (id,employee_no,name,email,department,grade,title,job_type_id,hire_date,status,salary)
      SELECT ?, ?, c.name, ?, ?, ?, ?, ?, ?, 'active', ?
      FROM candidates c JOIN candidate_applications ca ON ca.candidate_id = c.id
      WHERE ca.id = ? AND ca.status IN ('hired', 'onboarded')
        AND (c.email IS NULL OR lower(c.email) = lower(?))
        AND EXISTS (SELECT 1 FROM job_types jt WHERE jt.id = ? AND jt.active = 1)
        AND NOT EXISTS (
          SELECT 1 FROM onboarding_items oi
          LEFT JOIN application_onboarding_checklist aoc
            ON aoc.application_id = ca.id AND aoc.onboarding_item_id = oi.id
          WHERE oi.active = 1 AND oi.required = 1 AND COALESCE(aoc.completed, 0) = 0)
        AND NOT EXISTS (SELECT 1 FROM recruitment_employee_conversions x WHERE x.application_id = ca.id)
        AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.employee_no = ? OR lower(e.email) = lower(?))""",
    """INSERT INTO recruitment_employee_conversions(application_id,employee_id,created_by)
      SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM employees WHERE id = ?)""",
    """INSERT INTO candidate_application_status_history(id,application_id,from_status,to_status,changed_by,note)
      SELECT ?, id, 'hired', 'onboarded', ?, 'HR確認到職並建立員工主檔'
      FROM candidate_applications WHERE id = ? AND status = 'hired'
        AND EXISTS (SELECT 1 FROM recruitment_employee_conversions WHERE application_id = ? AND employee_id = ?)""",
    """UPDATE candidate_applications SET status = 'onboarded'
      WHERE id = ? AND status = 'hired'
        AND EXISTS (SELECT 1 FROM recruitment_employee_conversions WHERE application_id = ? AND employee_id = ?)""",
    """INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id,details)
      SELECT ?, ?, 'onboarding.convert', 'candidate_application', ?, ?
      WHERE EXISTS (SELECT 1 FROM recruitment_employee_conversions WHERE application_id = ? AND employee_id = ?)""",
]
binds = [
    ("probe-emp", "PROBE-1", "probe@example.com", "測試部", "G1", "測試職務", job_type, "2024-02-29", None, "probe-app", "probe@example.com", job_type, "PROBE-1", "probe@example.com"),
    ("probe-app", "probe-emp", "usr-admin", "probe-emp"),
    ("probe-history", "usr-admin", "probe-app", "probe-app", "probe-emp"),
    ("probe-app", "probe-app", "probe-emp"),
    ("probe-audit", "usr-admin", "probe-app", '{"employeeCreated":true}', "probe-app", "probe-emp"),
]
changes = [db.execute(sql, args).rowcount for sql, args in zip(statements, binds)]
db.commit()
assert changes == [1, 1, 1, 1, 1], changes
assert db.execute("SELECT status FROM candidate_applications WHERE id = 'probe-app'").fetchone()[0] == "onboarded"
assert "legacyBackfill" not in db.execute("SELECT details FROM audit_logs WHERE id = 'probe-audit'").fetchone()[0]
print("PASS: copied batch is sequentially visible in one SQLite transaction; hired audit is not legacy")
print("2 supplemental SQLite probes passed; not D1 or Vitest")
