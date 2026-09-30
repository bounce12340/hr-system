/**
 * 角色工作台的日期分組與列形狀。
 * 這是 Asia/Taipei 的呈現規則，不是訓練、到職或重訓政策。
 * training_records.valid_until 不參與這裡。
 */

export const WORKBENCH_TIMEZONE = "Asia/Taipei";

export const WORKBENCH_SOURCES = [
  "onboarding_missing",
  "course_session",
  "certification_expiry",
] as const;

export type WorkbenchSource = (typeof WORKBENCH_SOURCES)[number];

export const WORKBENCH_BUCKETS = [
  "today",
  "this_week",
  "overdue",
  "later",
  "past_unconfirmed",
  "unset",
] as const;

export type WorkbenchBucket = (typeof WORKBENCH_BUCKETS)[number];

export const ADMIN_WORKBENCH_TARGETS = [
  "recruitment/onboarding",
  "scheduling/attendance",
  "health/certifications",
] as const;

export const EMPLOYEE_WORKBENCH_TARGETS = ["schedule", "certifications"] as const;

export type AdminWorkbenchTarget = (typeof ADMIN_WORKBENCH_TARGETS)[number];
export type EmployeeWorkbenchTarget = (typeof EMPLOYEE_WORKBENCH_TARGETS)[number];
export type WorkbenchTarget = AdminWorkbenchTarget | EmployeeWorkbenchTarget;

export type WorkbenchSourceStatus = "ok" | "insufficient" | "error";

export interface WorkbenchItem {
  id: string;
  source: WorkbenchSource;
  title: string;
  reason: string;
  dueDate: string | null;
  bucket: WorkbenchBucket;
  nextAction: string;
  target: WorkbenchTarget;
}

export interface WorkbenchSourceState {
  status: WorkbenchSourceStatus;
  itemCount: number;
  message: string | null;
}

export interface TaipeiCalendar {
  today: string;
  weekStart: string;
  weekEnd: string;
  weekLabel: string;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

export function addIsoDays(isoDate: string, days: number): string {
  if (!isIsoDate(isoDate) || !Number.isInteger(days)) {
    throw new Error("addIsoDays 需要有效日期與整數天數。");
  }
  const [year, month, day] = isoDate.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day + days));
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 固定 now 可注入；未注入時用系統時鐘，再換算成台北日曆日。 */
export function taipeiToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: WORKBENCH_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  const iso = `${year}-${month}-${day}`;
  if (!isIsoDate(iso)) throw new Error("無法取得 Asia/Taipei 日期。");
  return iso;
}

export function weekBounds(today: string): { weekStart: string; weekEnd: string } {
  if (!isIsoDate(today)) throw new Error("weekBounds 需要有效日期。");
  const [year, month, day] = today.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const daysFromMonday = weekday === 0 ? 6 : weekday - 1;
  const weekStart = addIsoDays(today, -daysFromMonday);
  return { weekStart, weekEnd: addIsoDays(weekStart, 6) };
}

export function taipeiCalendar(now: Date = new Date()): TaipeiCalendar {
  const today = taipeiToday(now);
  const { weekStart, weekEnd } = weekBounds(today);
  return {
    today,
    weekStart,
    weekEnd,
    weekLabel: `${weekStart}（週一）至 ${weekEnd}（週日）`,
  };
}

export function certificationBucket(expiresAt: string | null, today: string): WorkbenchBucket | null {
  if (expiresAt === null) return null;
  if (!isIsoDate(expiresAt) || !isIsoDate(today)) return "unset";
  if (expiresAt < today) return "overdue";
  if (expiresAt === today) return "today";
  if (expiresAt <= weekBounds(today).weekEnd) return "this_week";
  return "later";
}

export function sessionBucket(sessionDate: string | null, today: string): WorkbenchBucket {
  if (sessionDate === null || !isIsoDate(sessionDate) || !isIsoDate(today)) return "unset";
  if (sessionDate < today) return "past_unconfirmed";
  if (sessionDate === today) return "today";
  if (sessionDate <= weekBounds(today).weekEnd) return "this_week";
  return "later";
}

export function compareWorkbenchItems(left: WorkbenchItem, right: WorkbenchItem): number {
  const bucketOrder = WORKBENCH_BUCKETS.indexOf(left.bucket) - WORKBENCH_BUCKETS.indexOf(right.bucket);
  if (bucketOrder !== 0) return bucketOrder;
  const leftDate = left.dueDate ?? "9999-99-99";
  const rightDate = right.dueDate ?? "9999-99-99";
  if (leftDate !== rightDate) return leftDate < rightDate ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function sourceState(items: WorkbenchItem[], source: WorkbenchSource): WorkbenchSourceState {
  const own = items.filter((item) => item.source === source);
  const insufficient = own.some((item) => item.bucket === "unset");
  if (insufficient) {
    return {
      status: "insufficient",
      itemCount: own.length,
      message: "此來源有日期無法分類的列，已放在未設定期限／待補資料，不是沒有待辦。",
    };
  }
  return { status: "ok", itemCount: own.length, message: null };
}

export function workbenchSummary(input: {
  loading: boolean;
  error: string | null;
  items: WorkbenchItem[];
  sources: Record<WorkbenchSource, WorkbenchSourceState> | null;
}): { headline: string; sourceLabels: string[] } {
  if (input.error) {
    return { headline: "工作台載入失敗，請重試。這不是沒有待辦。", sourceLabels: [] };
  }
  if (input.loading || !input.sources) {
    return { headline: "工作台讀取中。", sourceLabels: [] };
  }
  const sourceLabels = WORKBENCH_SOURCES.map((source) => {
    const state = input.sources?.[source];
    if (!state || state.status === "error") return `${source}：載入失敗`;
    if (state.status === "insufficient") return `${source}：資料不足`;
    if (state.itemCount === 0) return `${source}：無待辦`;
    return `${source}：${state.itemCount} 項`;
  });
  const insufficient = Object.values(input.sources).some((state) => state.status === "insufficient");
  if (input.items.length === 0 && insufficient) {
    return { headline: "沒有可列出的列，但有來源資料不足，不能視為全部正常。", sourceLabels };
  }
  if (input.items.length === 0) return { headline: "目前沒有工作台待辦。", sourceLabels };
  return { headline: "工作台待辦如下。", sourceLabels };
}
