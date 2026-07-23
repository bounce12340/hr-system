PRAGMA foreign_keys = ON;

CREATE TABLE job_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  required_level INTEGER NOT NULL CHECK (required_level BETWEEN 1 AND 3),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE employees (
  id TEXT PRIMARY KEY,
  employee_no TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  department TEXT NOT NULL,
  grade TEXT NOT NULL,
  title TEXT NOT NULL,
  job_type_id TEXT NOT NULL REFERENCES job_types(id),
  hire_date TEXT NOT NULL,
  termination_date TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  salary INTEGER CHECK (salary IS NULL OR salary >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  employee_id TEXT UNIQUE REFERENCES employees(id),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL DEFAULT 100000 CHECK (password_iterations >= 100000),
  role TEXT NOT NULL CHECK (role IN ('admin', 'employee')),
  must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  user_agent TEXT,
  ip_address TEXT
);

CREATE TABLE certifications (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  issuer TEXT NOT NULL,
  default_validity_months INTEGER,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE courses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  competency_level INTEGER NOT NULL CHECK (competency_level BETWEEN 1 AND 3),
  course_type TEXT NOT NULL CHECK (course_type IN ('mandatory', 'elective')),
  duration_hours REAL NOT NULL CHECK (duration_hours > 0),
  instructor TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  related_certification_id TEXT REFERENCES certifications(id),
  validity_months INTEGER CHECK (validity_months IS NULL OR validity_months > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  enrollment_open INTEGER NOT NULL DEFAULT 0 CHECK (enrollment_open IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE course_sessions (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id),
  session_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  location TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (start_time < end_time)
);

CREATE TABLE special_days (
  id TEXT PRIMARY KEY,
  special_date TEXT NOT NULL UNIQUE,
  day_type TEXT NOT NULL CHECK (day_type IN ('blackout', 'mandatory_all')),
  title TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  course_session_id TEXT REFERENCES course_sessions(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE enrollments (
  id TEXT PRIMARY KEY,
  course_session_id TEXT NOT NULL REFERENCES course_sessions(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  source TEXT NOT NULL CHECK (source IN ('auto', 'manual', 'self')),
  enrollment_status TEXT NOT NULL DEFAULT 'enrolled' CHECK (enrollment_status IN ('enrolled', 'waitlisted', 'cancelled')),
  attendance_status TEXT NOT NULL DEFAULT 'pending' CHECK (attendance_status IN ('pending', 'completed', 'absent', 'leave')),
  conflict_override INTEGER NOT NULL DEFAULT 0 CHECK (conflict_override IN (0, 1)),
  conflict_reason TEXT,
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  attended_at TEXT,
  completed_at TEXT,
  UNIQUE (course_session_id, employee_id)
);

CREATE TABLE training_records (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  course_id TEXT NOT NULL REFERENCES courses(id),
  course_session_id TEXT NOT NULL REFERENCES course_sessions(id),
  enrollment_id TEXT NOT NULL UNIQUE REFERENCES enrollments(id),
  completed_at TEXT NOT NULL,
  hours REAL NOT NULL CHECK (hours > 0),
  valid_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE conflict_overrides (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  new_session_id TEXT NOT NULL REFERENCES course_sessions(id) ON DELETE CASCADE,
  conflicting_session_id TEXT NOT NULL REFERENCES course_sessions(id),
  reason TEXT NOT NULL,
  overridden_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE tests (
  id TEXT PRIMARY KEY,
  course_session_id TEXT NOT NULL REFERENCES course_sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  passing_score REAL NOT NULL CHECK (passing_score BETWEEN 0 AND 100),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE test_results (
  id TEXT PRIMARY KEY,
  test_id TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  score REAL NOT NULL CHECK (score BETWEEN 0 AND 100),
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  retraining_required INTEGER NOT NULL DEFAULT 0 CHECK (retraining_required IN (0, 1)),
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (test_id, employee_id)
);

CREATE TABLE employee_certifications (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  certification_id TEXT NOT NULL REFERENCES certifications(id),
  certificate_number TEXT,
  issued_at TEXT NOT NULL,
  expires_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE attendance (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  attendance_date TEXT NOT NULL,
  absence_hours REAL NOT NULL DEFAULT 0 CHECK (absence_hours >= 0),
  overtime_hours REAL NOT NULL DEFAULT 0 CHECK (overtime_hours >= 0),
  absence_type TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'csv')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE job_openings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  department TEXT NOT NULL,
  headcount INTEGER NOT NULL CHECK (headcount > 0),
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'paused', 'closed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  source TEXT NOT NULL,
  job_opening_id TEXT REFERENCES job_openings(id),
  resume_url TEXT,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('applied', 'screening', 'interview', 'offer', 'hired', 'onboarded', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE candidate_status_history (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_by TEXT NOT NULL REFERENCES users(id),
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE interviews (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL CHECK (round_number > 0),
  scheduled_at TEXT NOT NULL,
  interviewer_name TEXT NOT NULL,
  location TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE interview_scores (
  id TEXT PRIMARY KEY,
  interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  comments TEXT NOT NULL DEFAULT ''
);

CREATE TABLE offers (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL UNIQUE REFERENCES candidates(id),
  expected_salary INTEGER,
  suggested_salary INTEGER,
  approved_salary INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'accepted', 'declined')),
  notice_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE onboarding_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE onboarding_checklist (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  onboarding_item_id TEXT NOT NULL REFERENCES onboarding_items(id),
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  completed_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  UNIQUE (candidate_id, onboarding_item_id)
);

CREATE TABLE probations (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL UNIQUE REFERENCES employees(id),
  start_date TEXT NOT NULL,
  duration_days INTEGER NOT NULL DEFAULT 90 CHECK (duration_days > 0),
  due_date TEXT NOT NULL,
  result TEXT CHECK (result IN ('passed', 'extended', 'failed')),
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE competency_models (
  id TEXT PRIMARY KEY,
  position_title TEXT NOT NULL,
  competency_name TEXT NOT NULL,
  required_level INTEGER NOT NULL CHECK (required_level BETWEEN 1 AND 5),
  description TEXT NOT NULL DEFAULT '',
  UNIQUE (position_title, competency_name)
);

CREATE TABLE nine_grid (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL UNIQUE REFERENCES employees(id),
  performance INTEGER NOT NULL CHECK (performance BETWEEN 1 AND 3),
  potential INTEGER NOT NULL CHECK (potential BETWEEN 1 AND 3),
  review_period TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE key_positions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  department TEXT NOT NULL,
  incumbent_employee_id TEXT REFERENCES employees(id),
  risk_level TEXT NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low', 'medium', 'high')),
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE successors (
  id TEXT PRIMARY KEY,
  key_position_id TEXT NOT NULL REFERENCES key_positions(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  readiness TEXT NOT NULL CHECK (readiness IN ('ready_now', 'one_two_years', 'three_plus_years')),
  notes TEXT NOT NULL DEFAULT '',
  UNIQUE (key_position_id, employee_id)
);

CREATE TABLE idp_plans (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  start_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'completed', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE idp_items (
  id TEXT PRIMARY KEY,
  idp_plan_id TEXT NOT NULL REFERENCES idp_plans(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed')),
  employee_notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'string' CHECK (value_type IN ('string', 'number', 'boolean', 'json')),
  description TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
