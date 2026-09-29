"""Supplemental SQLite probe for the round-2 date, legacy, and audit-flag fixes.

This is isolated SQLite only. It is not Vitest, Cloudflare D1, browser, staging,
or production evidence. Batch SQL is extracted from the conversion source so a
stale copied statement fails here instead of silently replaying the old audit flag.
SQLite sequential visibility does not prove D1 batch statement visibility.
"""
import datetime
import pathlib
import re
import sqlite3

root = pathlib.Path(__file__).resolve().parents[1]
source = (root / "src/server/onboarding-conversion.ts").read_text()
assert "export function strictIsoDate" in source
executable = "\n".join(
    line for line in source.splitlines()
    if not line.strip().startswith("*") and "Date.parse accepts overflow" not in line
)
assert "Date.parse(" not in executable
assert "SELECT status FROM candidate_applications WHERE id = ?" not in source
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


def extracted_batch_sql():
    body = source.split("const results = await db.batch([", 1)[1].split("]);", 1)[0]
    statements = re.findall(r"db\.prepare\(`(.*?)`\)", body, re.S)
    if len(statements) != 5:
        raise AssertionError(f"expected 5 batch statements, got {len(statements)}")
    audit = statements[4]
    if "CASE WHEN EXISTS (SELECT 1 FROM candidate_application_status_history WHERE id = ?)" not in audit:
        raise AssertionError("audit statement does not key the flag to this history id")
    if "current?.status" in source or "legacyBackfill ?" in source:
        raise AssertionError("audit flag still comes from a pre-batch status choice")
    return statements


STATEMENTS = extracted_batch_sql()
LEGACY_AUDIT = '{"employeeCreated":true,"legacyBackfill":true}'
STANDARD_AUDIT = '{"employeeCreated":true}'


def seed(db, application_id, candidate_id, email, status):
    job_type = db.execute("SELECT id FROM job_types WHERE active = 1 LIMIT 1").fetchone()[0]
    db.execute(
        "INSERT INTO candidates(id,name,email,source,status) VALUES (?, ?, ?, 'probe', ?)",
        (candidate_id, candidate_id, email, status),
    )
    db.execute(
        "INSERT INTO candidate_applications(id,candidate_id,job_opening_id,status) VALUES (?, ?, 'probe-job', ?)",
        (application_id, candidate_id, status),
    )
    for row in db.execute("SELECT id FROM onboarding_items WHERE active = 1 AND required = 1"):
        db.execute(
            "INSERT INTO application_onboarding_checklist(id,application_id,onboarding_item_id,completed) VALUES (?, ?, ?, 1)",
            (f"{application_id}-{row[0]}", application_id, row[0]),
        )
    return job_type


def binds(prefix, application_id, employee_id, email, job_type, history_id):
    return [
        (employee_id, prefix, email, "測試部", "G1", "測試職務", job_type, "2024-02-29", None,
         application_id, email, job_type, prefix, email),
        (application_id, employee_id, "usr-admin", employee_id),
        (history_id, "usr-admin", application_id, application_id, employee_id),
        (application_id, application_id, employee_id),
        (f"{prefix}-audit", "usr-admin", application_id, history_id, STANDARD_AUDIT, LEGACY_AUDIT,
         application_id, employee_id),
    ]


def run_batch(db, application_id, employee_id, email, job_type, history_id, employee_no):
    changes = [
        db.execute(sql, args).rowcount
        for sql, args in zip(STATEMENTS, binds(employee_no, application_id, employee_id, email, job_type, history_id))
    ]
    db.commit()
    return changes


db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys = ON")
for migration in sorted((root / "migrations").glob("*.sql")):
    db.executescript(migration.read_text())
db.execute("INSERT INTO job_openings(id,title,department,headcount,description,status) VALUES ('probe-job','probe','測試部',1,'probe','open')")
job_type = seed(db, "probe-app", "probe-candidate", "probe@example.com", "hired")
changes = run_batch(db, "probe-app", "probe-emp", "probe@example.com", job_type, "probe-history", "PROBE-1")
assert changes == [1, 1, 1, 1, 1], changes
assert db.execute("SELECT status FROM candidate_applications WHERE id = 'probe-app'").fetchone()[0] == "onboarded"
assert db.execute("SELECT details FROM audit_logs WHERE id = 'PROBE-1-audit'").fetchone()[0] == STANDARD_AUDIT
print("PASS: extracted hired batch writes a non-legacy audit when this history id exists")

# Stale pre-read would have seen hired. The batch itself sees onboarded.
job_type = seed(db, "stale-onboarded", "stale-onboarded-candidate", "stale-onboarded@example.com", "hired")
db.execute("UPDATE candidate_applications SET status = 'onboarded' WHERE id = 'stale-onboarded'")
changes = run_batch(
    db, "stale-onboarded", "stale-onboarded-emp", "stale-onboarded@example.com",
    job_type, "stale-onboarded-history", "PROBE-ONBOARDED",
)
assert changes == [1, 1, 0, 0, 1], changes
assert db.execute("SELECT status FROM candidate_applications WHERE id = 'stale-onboarded'").fetchone()[0] == "onboarded"
assert db.execute(
    "SELECT COUNT(*) FROM candidate_application_status_history WHERE id = 'stale-onboarded-history'"
).fetchone()[0] == 0
assert db.execute("SELECT details FROM audit_logs WHERE id = 'PROBE-ONBOARDED-audit'").fetchone()[0] == LEGACY_AUDIT
print("PASS: hired changed to onboarded before batch is audited as legacy and writes no fake history")

# Stale pre-read would have seen onboarded. The batch itself sees hired.
job_type = seed(db, "stale-hired", "stale-hired-candidate", "stale-hired@example.com", "onboarded")
db.execute("UPDATE candidate_applications SET status = 'hired' WHERE id = 'stale-hired'")
changes = run_batch(
    db, "stale-hired", "stale-hired-emp", "stale-hired@example.com",
    job_type, "stale-hired-history", "PROBE-HIRED",
)
assert changes == [1, 1, 1, 1, 1], changes
assert db.execute("SELECT status FROM candidate_applications WHERE id = 'stale-hired'").fetchone()[0] == "onboarded"
assert db.execute(
    "SELECT from_status, to_status, note FROM candidate_application_status_history WHERE id = 'stale-hired-history'"
).fetchone() == ("hired", "onboarded", "HR確認到職並建立員工主檔")
assert db.execute("SELECT details FROM audit_logs WHERE id = 'PROBE-HIRED-audit'").fetchone()[0] == STANDARD_AUDIT
print("PASS: onboarded changed back to hired before batch is audited as a standard conversion")
print("4 supplemental SQLite probes passed; not D1 or Vitest")
