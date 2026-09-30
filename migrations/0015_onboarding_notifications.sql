-- Explicit onboarding conversion. Notification rows are preparation only: dispatch policy
-- is not approved, so this migration creates no recipient/configuration setting.
CREATE TABLE recruitment_employee_conversions (
  application_id TEXT PRIMARY KEY REFERENCES candidate_applications(id),
  employee_id TEXT NOT NULL UNIQUE REFERENCES employees(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A future, separately approved scheduler may claim rows. `dedup_key` gives at-most-one
-- outbox intent, not exactly-once delivery: provider acknowledgement can be ambiguous.
CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY,
  dedup_key TEXT NOT NULL UNIQUE,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','sent','failed','unknown','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  claimed_at TEXT,
  claim_token TEXT,
  provider_message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sent_at TEXT
);
CREATE INDEX idx_notification_outbox_dispatch ON notification_outbox(status, available_at, created_at);
