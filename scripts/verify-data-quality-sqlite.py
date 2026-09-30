#!/usr/bin/env python3
"""隔離 SQLite 探針：資料待補 SQL 與 schema 保證。不是 Vitest、不是 D1。"""

import sqlite3
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def apply_schema(db: sqlite3.Connection) -> None:
    db.execute("PRAGMA foreign_keys=OFF")
    for path in sorted((ROOT / "migrations").glob("*.sql")):
        db.executescript(path.read_text())
    db.execute("PRAGMA foreign_keys=ON")


def main() -> None:
    with tempfile.TemporaryDirectory() as directory:
        db = sqlite3.connect(Path(directory) / "probe.sqlite")
        db.row_factory = sqlite3.Row
        apply_schema(db)
        job_type_id = db.execute("SELECT id FROM job_types LIMIT 1").fetchone()["id"]
        db.execute(
            """
            INSERT INTO employees (
              id, employee_no, name, email, department, grade, title, job_type_id, hire_date, birth_date, status
            ) VALUES
              ('e-ok', 'DQ-E1', '正常', 'dq-ok@example.com', '診所事業部', 'G1', '職', ?, '2020-01-15', '1990-01-01', 'active'),
              ('e-birth', 'DQ-E2', '缺生日', 'dq-birth@example.com', '診所事業部', 'G1', '職', ?, '2020-01-15', NULL, 'active'),
              ('e-dept', 'DQ-E3', '空白部門', 'dq-dept@example.com', '   ', 'G1', '職', ?, '2020-01-15', '1991-01-01', 'active')
            """,
            (job_type_id, job_type_id, job_type_id),
        )
        db.execute(
            """
            INSERT INTO users (
              id, email, password_hash, password_salt, password_iterations, role, employee_id, archived_at
            ) VALUES
              ('u-link', 'dq-linked@example.com', 'h', 's', 100000, 'employee', 'e-ok', NULL),
              ('u-open', 'dq-open@example.com', 'h', 's', 100000, 'employee', NULL, NULL),
              ('u-arch', 'dq-arch@example.com', 'h', 's', 100000, 'employee', NULL, '2026-01-01T00:00:00.000Z')
            """
        )
        employees = db.execute(
            """
            SELECT id, birth_date AS birthDate, department
            FROM employees
            WHERE birth_date IS NULL OR TRIM(birth_date) = '' OR TRIM(department) = ''
            ORDER BY id
            """
        ).fetchall()
        users = db.execute(
            """
            SELECT id FROM users
            WHERE employee_id IS NULL AND archived_at IS NULL
            ORDER BY id
            """
        ).fetchall()
        employee_ids = [row["id"] for row in employees]
        user_ids = [row["id"] for row in users]
        assert employee_ids == ["e-birth", "e-dept"], employee_ids
        assert user_ids == ["u-open"], user_ids
        columns = {
            row["name"]: row
            for row in db.execute("PRAGMA table_info(employees)").fetchall()
        }
        assert columns["job_type_id"]["notnull"] == 1
        assert columns["hire_date"]["notnull"] == 1
        assert columns["department"]["notnull"] == 1
        try:
            db.execute(
                """
                INSERT INTO employees (
                  id, employee_no, name, email, department, grade, title, job_type_id, hire_date, status
                ) VALUES ('e-null-hire', 'DQ-E4', '空到職', 'dq-hire@example.com', '部', 'G1', '職', ?, NULL, 'active')
                """,
                (job_type_id,),
            )
            raise SystemExit("hire_date NULL was accepted")
        except sqlite3.IntegrityError:
            pass
        print("data-quality sqlite probe: 4 assertions passed")


if __name__ == "__main__":
    main()
