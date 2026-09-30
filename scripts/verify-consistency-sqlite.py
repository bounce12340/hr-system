"""Supplemental SQLite probes of actual source SQL; NOT Vitest/D1/browser tests."""
import sqlite3, pathlib, re
root=pathlib.Path(__file__).resolve().parents[1]
db=sqlite3.connect(':memory:')
db.execute('PRAGMA foreign_keys=ON')
for p in sorted((root/'migrations').glob('*.sql')):
    db.executescript(p.read_text())
print('PASS: all 14 migrations and seed applied to isolated SQLite')
def query(file, marker):
    text=(root/file).read_text(); start=text.index(marker)
    return re.search(r'prepare\(`(.*?)`\)',text[start:],re.S).group(1)
sql=query('src/server/m4.ts','async function createAttendanceRecord')
a=['probe-a','emp-002','2010-01-01',2,0,None,'first']
b=['probe-b','emp-002','2010-01-01',5,0,None,'second']
assert db.execute(sql,a).fetchone()[0]=='probe-a'
assert db.execute(sql,b).fetchone()[0]=='probe-a'
assert db.execute("SELECT COUNT(*),absence_hours FROM attendance WHERE attendance_date='2010-01-01'").fetchone()==(1,5)
print('PASS: source attendance upsert preserves ID and one-row invariant')
db.execute('DROP INDEX idx_attendance_employee_date_unique')
db.execute("INSERT INTO attendance (id,employee_id,attendance_date) VALUES ('dup','emp-002','2010-01-01')")
try: db.executescript((root/'migrations/0014_attendance_unique.sql').read_text()); raise AssertionError('duplicate accepted')
except sqlite3.IntegrityError: pass
assert db.execute("SELECT COUNT(*) FROM attendance WHERE attendance_date='2010-01-01'").fetchone()[0]==2
print('PASS: duplicate migration safely fails without deleting rows')
text=(root/'src/server/m3.ts').read_text().split('async function transitionApplication',1)[1].split('async function applicationHistory',1)[0]
queries=re.findall(r'prepare\(`(.*?)`\)',text,re.S)
id=db.execute("SELECT id FROM candidate_applications WHERE status='applied' LIMIT 1").fetchone()[0]
assert db.execute(queries[0],['hist-probe','screening','usr-admin','probe',id,'applied']).rowcount==1
assert db.execute(queries[1],['screening',id,'applied']).rowcount==1
assert db.execute(queries[0],['hist-stale','screening','usr-admin','stale',id,'applied']).rowcount==0
assert db.execute(queries[1],['screening',id,'applied']).rowcount==0
print('PASS: source conditional recruitment history rejects stale state')
text=(root/'src/server/m2.ts').read_text().split('const results = await context.env.DB.batch(records.map',1)[1]
sql=re.search(r'prepare\(`(.*?)`\)',text,re.S).group(1)
db.execute("INSERT INTO tests(id,course_session_id,name,passing_score) VALUES ('probe-test','cs-01','probe',90)")
args=['score-probe','emp-002',80,80,80,'probe-test','cs-01']
assert db.execute(sql,args).rowcount==1
assert db.execute("SELECT passed,retraining_required FROM test_results WHERE test_id='probe-test'").fetchone()==(0,1)
db.execute("UPDATE tests SET course_session_id='cs-02' WHERE id='probe-test'")
assert db.execute(sql,args).rowcount==0
print('PASS: source score insertion uses current threshold and rejects stale session')
print('5 supplemental probes passed; no production data accessed')
