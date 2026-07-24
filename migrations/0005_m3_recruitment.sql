CREATE TABLE candidate_applications (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  job_opening_id TEXT NOT NULL REFERENCES job_openings(id),
  status TEXT NOT NULL DEFAULT 'applied' CHECK (
    status IN (
      'applied',
      'screening',
      'interview',
      'salary_approval',
      'offer',
      'hired',
      'onboarded',
      'rejected'
    )
  ),
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (candidate_id, job_opening_id)
);

INSERT INTO candidate_applications (
  id,
  candidate_id,
  job_opening_id,
  status,
  applied_at,
  updated_at
)
SELECT
  'app-' || id,
  id,
  job_opening_id,
  CASE status
    WHEN 'applied' THEN 'applied'
    WHEN 'screening' THEN 'screening'
    WHEN 'interview' THEN 'interview'
    WHEN 'offer' THEN 'offer'
    WHEN 'hired' THEN 'hired'
    WHEN 'onboarded' THEN 'onboarded'
    ELSE 'rejected'
  END,
  created_at,
  updated_at
FROM candidates
WHERE job_opening_id IS NOT NULL;

CREATE TABLE candidate_application_status_history (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES candidate_applications(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL CHECK (
    to_status IN (
      'applied',
      'screening',
      'interview',
      'salary_approval',
      'offer',
      'hired',
      'onboarded',
      'rejected'
    )
  ),
  changed_by TEXT NOT NULL REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '',
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO candidate_application_status_history (
  id,
  application_id,
  from_status,
  to_status,
  changed_by,
  note,
  changed_at
)
SELECT
  'app-history-' || ca.candidate_id,
  ca.id,
  NULL,
  ca.status,
  (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1),
  '由既有候選人資料移轉',
  ca.applied_at
FROM candidate_applications ca;

ALTER TABLE interviews ADD COLUMN application_id TEXT REFERENCES candidate_applications(id) ON DELETE CASCADE;
ALTER TABLE interviews ADD COLUMN notes TEXT NOT NULL DEFAULT '';

CREATE TABLE salary_approvals (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL UNIQUE REFERENCES candidate_applications(id) ON DELETE CASCADE,
  expected_salary INTEGER CHECK (expected_salary IS NULL OR expected_salary >= 0),
  suggested_salary INTEGER CHECK (suggested_salary IS NULL OR suggested_salary >= 0),
  approved_salary INTEGER CHECK (approved_salary IS NULL OR approved_salary >= 0),
  compensation_notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE recruitment_offers (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL UNIQUE REFERENCES candidate_applications(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'declined')),
  notice_text TEXT NOT NULL,
  sent_at TEXT,
  responded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE application_onboarding_checklist (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES candidate_applications(id) ON DELETE CASCADE,
  onboarding_item_id TEXT NOT NULL REFERENCES onboarding_items(id),
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  completed_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  UNIQUE (application_id, onboarding_item_id)
);

ALTER TABLE probations ADD COLUMN candidate_application_id TEXT REFERENCES candidate_applications(id);

INSERT OR IGNORE INTO settings (setting_key, setting_value, value_type, description)
VALUES ('probation_reminder_days', '14', 'number', '試用期到期提前提醒天數');

CREATE INDEX idx_candidate_applications_opening_status
ON candidate_applications(job_opening_id, status, updated_at);

CREATE INDEX idx_candidate_applications_candidate
ON candidate_applications(candidate_id, updated_at);

CREATE INDEX idx_application_history_stage_time
ON candidate_application_status_history(to_status, changed_at);

CREATE INDEX idx_interviews_application
ON interviews(application_id, round_number, scheduled_at);

CREATE UNIQUE INDEX idx_interviews_application_round
ON interviews(application_id, round_number)
WHERE application_id IS NOT NULL;

CREATE INDEX idx_salary_approvals_status
ON salary_approvals(status, updated_at);

CREATE INDEX idx_recruitment_offers_status
ON recruitment_offers(status, updated_at);

CREATE INDEX idx_application_onboarding
ON application_onboarding_checklist(application_id, completed);

CREATE INDEX idx_probations_application
ON probations(candidate_application_id);
