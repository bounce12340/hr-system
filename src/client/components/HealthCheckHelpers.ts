import type { HealthCheckResultValue, HealthCheckStatus } from "../types";

// ---- M6 共用工具（供 M6AdminPages.tsx 與 M6EmployeePages.tsx 共用）----
// 健檢頻率依《勞工健康保護規則》年齡分級：未滿 40 歲每 5 年、40–65 歲每 3
// 年、65 歲以上每年。這裡只負責「把規則講給使用者聽」，intervalMonths／
// status／statusLabel 一律以後端（src/server/health.ts）回傳值為準。

export function intervalReasonText(age: number | null): string {
  if (age === null || age === undefined) return "尚未登記出生日期，無法計算健檢頻率";
  if (age < 40) return `未滿 40 歲（現年 ${age} 歲）・每 5 年檢查一次`;
  if (age < 65) return `40–65 歲（現年 ${age} 歲）・每 3 年檢查一次`;
  return `65 歲以上（現年 ${age} 歲）・每年檢查一次`;
}

// 與 src/server/health.ts 的 STATUS_LABELS 一致，僅在後端未附 statusLabel 時當備援。
export const HEALTH_STATUS_FALLBACK_LABEL: Record<HealthCheckStatus, string> = {
  overdue: "已逾期",
  due_soon: "即將到期",
  ok: "尚未到期",
  never: "從未健檢",
  missing_birth_date: "缺生日資料",
};

export const HEALTH_STATUS_CLASS: Record<HealthCheckStatus, string> = {
  overdue: "status danger",
  due_soon: "status warning",
  ok: "status ok",
  never: "status never",
  missing_birth_date: "status missing",
};

export const HEALTH_STATUS_ROW_CLASS: Record<HealthCheckStatus, string> = {
  overdue: "due-row-overdue",
  due_soon: "due-row-soon",
  ok: "",
  never: "due-row-never",
  missing_birth_date: "due-row-missing",
};

export function monthsUntilDueText(months: number | null): string {
  if (months === null || months === undefined) return "—";
  if (months < 0) return `已逾期 ${Math.abs(months)} 個月`;
  if (months === 0) return "本月應檢";
  return `${months} 個月後`;
}

export const RESULT_FALLBACK_LABEL: Record<HealthCheckResultValue, string> = {
  normal: "正常",
  abnormal: "異常",
  follow_up: "需複檢",
  pending: "待判讀",
};

export const RESULT_CLASS: Record<HealthCheckResultValue, string> = {
  normal: "status ok",
  abnormal: "status danger",
  follow_up: "status warning",
  pending: "status",
};

export const RESULT_OPTIONS: HealthCheckResultValue[] = ["pending", "normal", "abnormal", "follow_up"];
