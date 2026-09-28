import { ApiError, json, parseJson } from "./http";
import { expiryReminders } from "./m2";
import { healthCheckReminders } from "./health";
import { probationReminders } from "./m3";
import type { ApiContext } from "./types";

/**
 * Notification policy (recipients, events, retention and provider) is not approved.
 * Therefore this module deliberately exposes only an authenticated HR dry-run.
 * `notification_outbox` is schema-only preparation: no request may claim or send it
 * until a separately approved scheduler/dispatch design is introduced.
 */
export async function handleReminderNotifications(context: ApiContext, path: string): Promise<Response | null> {
  if (path === "/api/admin/reminder-notifications/config" && context.request.method === "GET") {
    return json({
      enabled: false,
      deliveryAvailable: false,
      policyPending: true,
      message: "收件人與事件政策尚未確認；派送固定關閉，僅可執行乾跑。",
    });
  }

  if (path !== "/api/admin/reminder-notifications/run" || context.request.method !== "POST") return null;
  const body = await parseJson<{ dryRun?: unknown }>(context.request);
  if (body.dryRun !== true) {
    throw new ApiError(409, "通知派送尚未核准；此端點只接受 dryRun: true，且不會寫入 outbox 或寄信。");
  }

  const [certifications, probations, healthChecks] = await Promise.all([
    expiryReminders(context.env.DB),
    probationReminders(context.env.DB),
    healthCheckReminders(context.env.DB),
  ]);
  const dedupKey = `hr-summary:${new Date().toISOString().slice(0, 10)}`;
  // Deliberately count-only: no names, email, salary, certificate labels, health
  // findings, diagnoses, notes, employee numbers, or other sensitive details leave
  // the authenticated UI response or a future message body.
  const preview = `HR 提醒摘要：證照到期 ${certifications.length} 件；試用期需關注 ${probations.length} 件；健檢需關注 ${healthChecks.length} 人。請登入 HR 系統查看授權詳情。`;
  return json({
    dryRun: true,
    queued: false,
    deliveryAvailable: false,
    policyPending: true,
    dedupKey,
    counts: { certifications: certifications.length, probations: probations.length, healthChecks: healthChecks.length },
    preview,
  });
}
