import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isIsoDate(value) {
  const match = DATE_PATTERN.exec(value ?? "");
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function addIsoDays(isoDate, days) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function taipeiToday(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return `${parts.find((part) => part.type === "year").value}-${parts.find((part) => part.type === "month").value}-${parts.find((part) => part.type === "day").value}`;
}

function weekBounds(today) {
  const [year, month, day] = today.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const weekStart = addIsoDays(today, weekday === 0 ? -6 : 1 - weekday);
  return { weekStart, weekEnd: addIsoDays(weekStart, 6) };
}

function certificationBucket(expiresAt, today) {
  if (expiresAt === null) return null;
  if (!isIsoDate(expiresAt) || !isIsoDate(today)) return "unset";
  if (expiresAt < today) return "overdue";
  if (expiresAt === today) return "today";
  if (expiresAt <= weekBounds(today).weekEnd) return "this_week";
  return "later";
}

function sessionBucket(sessionDate, today) {
  if (!sessionDate || !isIsoDate(sessionDate) || !isIsoDate(today)) return "unset";
  if (sessionDate < today) return "past_unconfirmed";
  if (sessionDate === today) return "today";
  if (sessionDate <= weekBounds(today).weekEnd) return "this_week";
  return "later";
}

function workbenchSummary(input) {
  if (input.error) return "工作台載入失敗，請重試。這不是沒有待辦。";
  if (input.loading || !input.sources) return "工作台讀取中。";
  const insufficient = Object.values(input.sources).some((state) => state.status === "insufficient");
  if (input.items.length === 0 && insufficient) return "沒有可列出的列，但有來源資料不足，不能視為全部正常。";
  if (input.items.length === 0) return "目前沒有工作台待辦。";
  return "工作台待辦如下。";
}

const today = "2026-09-29";
assert.equal(taipeiToday(new Date("2026-09-28T16:30:00Z")), "2026-09-29");
assert.equal(taipeiToday(new Date("2026-09-28T15:30:00Z")), "2026-09-28");
assert.deepEqual(weekBounds("2026-09-27"), { weekStart: "2026-09-21", weekEnd: "2026-09-27" });
assert.deepEqual(weekBounds("2026-09-28"), { weekStart: "2026-09-28", weekEnd: "2026-10-04" });
assert.equal(certificationBucket(today, today), "today");
assert.equal(certificationBucket("2026-09-28", today), "overdue");
assert.equal(certificationBucket("2026-10-04", today), "this_week");
assert.equal(certificationBucket(null, today), null);
assert.equal(certificationBucket("not-a-date", today), "unset");
assert.equal(sessionBucket("2020-01-01", today), "past_unconfirmed");
assert.equal(workbenchSummary({ loading: false, error: null, items: [], sources: { a: { status: "ok" } } }), "目前沒有工作台待辦。");
assert.equal(workbenchSummary({ loading: false, error: "x", items: [], sources: null }).includes("載入失敗"), true);
assert.equal(workbenchSummary({
  loading: false,
  error: null,
  items: [],
  sources: { a: { status: "insufficient" } },
}).includes("資料不足"), true);

const root = new URL("..", import.meta.url).pathname;
const db = new DatabaseSync(":memory:");
for (const file of readdirSync(join(root, "migrations")).filter((name) => name.endsWith(".sql")).sort()) {
  db.exec(readFileSync(join(root, "migrations", file), "utf8"));
}
db.prepare("UPDATE candidate_applications SET status = 'hired' WHERE id = 'app-cand-01'").run();
db.prepare(`
  INSERT INTO application_onboarding_checklist (
    id, application_id, onboarding_item_id, completed, completed_at, notes
  ) VALUES ('aoc-done', 'app-cand-02', 'obi-01', 1, '2026-09-01T00:00:00.000Z', 'done')
`).run();
db.prepare("UPDATE course_sessions SET session_date = '2020-01-01', status = 'scheduled' WHERE id = 'cs-01'").run();
db.prepare("UPDATE course_sessions SET status = 'cancelled' WHERE id = 'cs-02'").run();
db.prepare("UPDATE enrollments SET enrollment_status = 'cancelled' WHERE id = 'enr-cs06-emp-002'").run();
db.prepare(`
  INSERT INTO employee_certifications (
    id, employee_id, certification_id, certificate_number, issued_at, expires_at, notes
  ) VALUES
    ('ec-bad', 'emp-002', 'cert-hospital', 'BAD', '2026-01-01', 'not-a-date', ''),
    ('ec-forever', 'emp-002', 'cert-product', 'FOREVER', '2026-01-01', NULL, '')
`).run();

const gaps = db.prepare(`
  SELECT ca.id AS applicationId, oi.id AS itemId
  FROM candidate_applications ca
  JOIN onboarding_items oi ON oi.active = 1 AND oi.required = 1
  LEFT JOIN application_onboarding_checklist aoc
    ON aoc.application_id = ca.id AND aoc.onboarding_item_id = oi.id
  WHERE ca.status IN ('hired', 'onboarded') AND COALESCE(aoc.completed, 0) = 0
`).all();
assert.equal(gaps.some((row) => row.applicationId === "app-cand-01" && row.itemId === "obi-01"), true);
assert.equal(gaps.some((row) => row.applicationId === "app-cand-02" && row.itemId === "obi-01"), false);

const sessions = db.prepare(`
  SELECT en.id AS enrollmentId, cs.session_date AS sessionDate
  FROM enrollments en
  JOIN course_sessions cs ON cs.id = en.course_session_id
  WHERE en.employee_id = ? AND en.enrollment_status = 'enrolled' AND cs.status = 'scheduled'
`).all("emp-002");
assert.equal(sessions.some((row) => row.enrollmentId === "enr-cs02-emp-002"), false);
assert.equal(sessions.some((row) => row.enrollmentId === "enr-cs06-emp-002"), false);
assert.equal(sessionBucket(sessions.find((row) => row.enrollmentId === "enr-cs01-emp-002").sessionDate, today), "past_unconfirmed");

const certs = db.prepare(`
  SELECT id, expires_at AS expiresAt FROM employee_certifications WHERE employee_id = ?
`).all("emp-002");
assert.equal(certs.some((row) => row.id === "ec-forever"), true);
assert.equal(db.prepare(`
  SELECT id FROM employee_certifications WHERE employee_id = ? AND expires_at IS NOT NULL AND id = 'ec-forever'
`).get("emp-002"), undefined);
assert.equal(certificationBucket(certs.find((row) => row.id === "ec-bad").expiresAt, today), "unset");
assert.equal(db.prepare("SELECT id FROM employee_certifications WHERE employee_id = ? AND id = 'ec-02'").get("emp-002"), undefined);

console.log(JSON.stringify({
  level: "node-sqlite-source-sql-plus-local-pure-copy",
  note: "分類函式在此檔是 products 規則的可執行複本；Vitest 仍負責直接 import src/shared/workbench.ts。",
  gaps: gaps.length,
  ownScheduledSessions: sessions.length,
}));
