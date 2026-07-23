import type { CertificationReminder } from "../types";
import { h } from "preact";

export function expiryText(days: number): string {
  if (days < 0) return `已逾期 ${Math.abs(days)} 天`;
  if (days === 0) return "今天到期";
  return `${days} 天後到期`;
}

interface CertificationReminderListProps {
  reminders: CertificationReminder[];
  showEmployee: boolean;
  emptyText: string;
}

export function CertificationReminderList({
  reminders,
  showEmployee,
  emptyText,
}: CertificationReminderListProps) {
  const cards = reminders.map((reminder) => h(
    "article",
    {
      class: "reminder-card",
      key: reminder.id,
      "data-certification-id": reminder.id,
    },
    h("div", { class: "reminder-icon" }, "!"),
    h(
      "div",
      null,
      h(
        "strong",
        null,
        showEmployee ? `${reminder.employeeName}・` : "",
        reminder.certificationName,
      ),
      h(
        "p",
        null,
        showEmployee ? `${reminder.department}・` : "",
        `${reminder.issuer}・到期日 ${reminder.expiresAt}`,
      ),
    ),
    h(
      "span",
      { class: reminder.daysUntilExpiry <= 30 ? "urgent" : "" },
      expiryText(reminder.daysUntilExpiry),
    ),
  ));
  const children = cards.length === 0
    ? [h("div", { class: "empty-state" }, emptyText)]
    : cards;
  return h("div", { class: "reminder-list" }, children);
}
