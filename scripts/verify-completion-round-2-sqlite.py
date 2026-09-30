"""Isolated SQLite probes for completion round 2; not D1, Vitest, browser, or production."""
import pathlib
import sqlite3

root = pathlib.Path(__file__).resolve().parents[1]
db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys = ON")
for migration in sorted((root / "migrations").glob("*.sql")):
    db.executescript(migration.read_text())
print("PASS: all 15 migrations applied to isolated SQLite")

# Minimal hired application with all currently active required items completed.
db.execute("INSERT INTO job_openings(id,title,department,headcount,description,status) VALUES ('r2-job','R2','測試部',1,'test','open')")
db.execute("INSERT INTO candidates(id,name,email,source,status) VALUES ('r2-candidate','測試候選人','r2@example.com','probe','hired')")
db.execute("INSERT INTO candidate_applications(id,candidate_id,job_opening_id,status) VALUES ('r2-app','r2-candidate','r2-job','hired')")
for row in db.execute("SELECT id FROM onboarding_items WHERE active=1 AND required=1"):
    db.execute("INSERT INTO application_onboarding_checklist(id,application_id,onboarding_item_id,completed) VALUES (?, 'r2-app', ?, 1)", (f"r2-check-{row[0]}", row[0]))

conversion_sql = """
INSERT INTO employees (id,employee_no,name,email,department,grade,title,job_type_id,hire_date,status,salary)
SELECT ?, ?, c.name, ?, ?, ?, ?, ?, ?, 'active', ?
FROM candidates c JOIN candidate_applications ca ON ca.candidate_id=c.id
WHERE ca.id=? AND ca.status IN ('hired', 'onboarded') AND (c.email IS NULL OR lower(c.email)=lower(?))
  AND EXISTS (SELECT 1 FROM job_types jt WHERE jt.id=? AND jt.active=1)
  AND NOT EXISTS (SELECT 1 FROM onboarding_items oi LEFT JOIN application_onboarding_checklist aoc ON aoc.application_id=ca.id AND aoc.onboarding_item_id=oi.id WHERE oi.active=1 AND oi.required=1 AND COALESCE(aoc.completed,0)=0)
  AND NOT EXISTS (SELECT 1 FROM recruitment_employee_conversions x WHERE x.application_id=ca.id)
  AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.employee_no=? OR lower(e.email)=lower(?))
"""
job_type = db.execute("SELECT id FROM job_types WHERE active=1 LIMIT 1").fetchone()[0]
args = ['r2-emp', 'R2-001', 'r2@example.com', '測試部', 'G1', '測試職務', job_type, '2026-09-28', None, 'r2-app', 'r2@example.com', job_type, 'R2-001', 'r2@example.com']
assert db.execute(conversion_sql, args).rowcount == 1
db.execute("INSERT INTO recruitment_employee_conversions(application_id,employee_id,created_by) VALUES ('r2-app','r2-emp','usr-admin')")
assert db.execute(conversion_sql, args).rowcount == 0
assert db.execute("SELECT COUNT(*) FROM employees WHERE id='r2-emp'").fetchone()[0] == 1
print("PASS: conversion predicate creates once and rejects duplicate retry")

# Missing required checklist must block the conditional insert.
db.execute("INSERT INTO candidates(id,name,email,source,status) VALUES ('r2-candidate-missing','缺件候選人','r2-missing@example.com','probe','hired')")
db.execute("INSERT INTO candidate_applications(id,candidate_id,job_opening_id,status) VALUES ('r2-app-missing','r2-candidate-missing','r2-job','hired')")
missing_args = ['r2-emp-missing', 'R2-002', 'r2-missing@example.com', '測試部', 'G1', '測試職務', job_type, '2026-09-28', None, 'r2-app-missing', 'r2-missing@example.com', job_type, 'R2-002', 'r2-missing@example.com']
assert db.execute(conversion_sql, missing_args).rowcount == 0
print("PASS: missing required onboarding item blocks conversion")

# The unique outbox intent key and allowed unknown state support future safe dispatch.
db.execute("INSERT INTO notification_outbox(id,dedup_key,recipient,subject,text_body,status) VALUES ('out-1','daily:2026-09-28','hr@example.com','s','count-only','unknown')")
try:
    db.execute("INSERT INTO notification_outbox(id,dedup_key,recipient,subject,text_body) VALUES ('out-2','daily:2026-09-28','hr@example.com','s','count-only')")
    raise AssertionError("duplicate notification intent accepted")
except sqlite3.IntegrityError:
    pass
assert db.execute("SELECT status FROM notification_outbox WHERE id='out-1'").fetchone()[0] == 'unknown'
print("PASS: outbox unique intent and unknown-delivery state preserved")

source = (root / "src/server/onboarding-conversion.ts").read_text()
assert "status IN ('hired', 'onboarded')" in source
assert "legacyBackfill" in source
executable = "\n".join(line for line in source.splitlines() if not line.strip().startswith("*") and "Date.parse accepts overflow" not in line)
assert "Date.parse(" not in executable
m3 = (root / "src/server/m3.ts").read_text()
assert 'hired: ["rejected"]' in m3
assert 'target === "onboarded"' in m3
ui = (root / "src/client/pages/M3AdminPages.tsx").read_text()
assert 'hired: "onboarded"' not in ui
assert "補建員工主檔" in ui
print("PASS: source no longer uses Date.parse or the old hired-to-onboarded transition")

db.execute("INSERT INTO candidates(id,name,email,source,status) VALUES ('r2-legacy-candidate','既有到職','r2-legacy@example.com','probe','hired')")
db.execute("INSERT INTO candidate_applications(id,candidate_id,job_opening_id,status) VALUES ('r2-legacy','r2-legacy-candidate','r2-job','onboarded')")
for row in db.execute("SELECT id FROM onboarding_items WHERE active=1 AND required=1"):
    db.execute("INSERT INTO application_onboarding_checklist(id,application_id,onboarding_item_id,completed) VALUES (?, 'r2-legacy', ?, 1)", (f"r2-legacy-check-{row[0]}", row[0]))
history_before = db.execute("SELECT COUNT(*) FROM candidate_application_status_history WHERE application_id='r2-legacy' AND to_status='onboarded'").fetchone()[0]
legacy_args = ['r2-legacy-emp', 'R2-LEGACY', 'r2-legacy@example.com', '測試部', 'G1', '測試職務', job_type, '2024-02-29', None, 'r2-legacy', 'r2-legacy@example.com', job_type, 'R2-LEGACY', 'r2-legacy@example.com']
assert db.execute(conversion_sql, legacy_args).rowcount == 1
assert db.execute("SELECT COUNT(*) FROM candidate_application_status_history WHERE application_id='r2-legacy' AND to_status='onboarded'").fetchone()[0] == history_before
print("PASS: legacy onboarded predicate inserts employee without a fake hired history row")

db.execute("INSERT INTO employees(id,employee_no,name,email,department,grade,title,job_type_id,hire_date,status) VALUES ('r2-taken','R2-TAKEN','占用','taken@example.com','人資行政部','G1','占用',?,'2020-01-01','active')", (job_type,))
db.execute("INSERT INTO candidates(id,name,email,source,status) VALUES ('r2-conflict-candidate','衝突','conflict@example.com','probe','hired')")
db.execute("INSERT INTO candidate_applications(id,candidate_id,job_opening_id,status) VALUES ('r2-conflict','r2-conflict-candidate','r2-job','hired')")
for row in db.execute("SELECT id FROM onboarding_items WHERE active=1 AND required=1"):
    db.execute("INSERT INTO application_onboarding_checklist(id,application_id,onboarding_item_id,completed) VALUES (?, 'r2-conflict', ?, 1)", (f"r2-conflict-check-{row[0]}", row[0]))
conflict_args = ['r2-conflict-emp', 'R2-TAKEN', 'conflict@example.com', '測試部', 'G1', '測試職務', job_type, '2026-09-28', None, 'r2-conflict', 'conflict@example.com', job_type, 'R2-TAKEN', 'conflict@example.com']
assert db.execute(conversion_sql, conflict_args).rowcount == 0
email_args = ['r2-conflict-emp', 'R2-NEW', 'taken@example.com', '測試部', 'G1', '測試職務', job_type, '2026-09-28', None, 'r2-conflict', 'conflict@example.com', job_type, 'R2-NEW', 'taken@example.com']
assert db.execute(conversion_sql, email_args).rowcount == 0
print("PASS: occupied employee number or email blocks the conditional insert")
print("7 isolated SQLite probes passed; not D1, Vitest, browser, or production")
