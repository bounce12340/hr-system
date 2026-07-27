import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import {
  HEALTH_STATUS_CLASS,
  HEALTH_STATUS_FALLBACK_LABEL,
  intervalReasonText,
  monthsUntilDueText,
} from "../components/HealthCheckHelpers";
import type { EmployeeHealthChecksPayload } from "../types";

// ---- M6：員工「我的健檢」----
// 對應後端 GET /api/employee/health-checks（src/server/health.ts 的
// employeeHealthChecks）。回應為 { reminderMonths, summary, healthChecks }，
// summary 與待健檢名單同一套欄位（employeeId／age／intervalMonths／
// nextDueDate／monthsUntilDue／status／statusLabel／dueBasis）。

export function MyHealthChecksPage() {
  const [data, setData] = useState<EmployeeHealthChecksPayload | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void api<EmployeeHealthChecksPayload>("/api/employee/health-checks")
      .then(setData)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "讀取失敗。"));
  }, []);

  const summary = data?.summary ?? null;

  return (
    <section>
      <div class="page-heading"><div><p class="eyebrow">MY HEALTH CHECKUP</p><h1>我的健檢</h1><p>查看健檢紀錄與下次應檢日；頻率依《勞工健康保護規則》年齡分級自動計算。</p></div></div>
      {error && <div class="alert error">{error}</div>}
      <div class="employee-hero">
        <div>
          <p class="eyebrow">下次應檢日</p>
          <h1>{summary?.nextDueDate ?? "—"}</h1>
          <p>{intervalReasonText(summary?.age ?? null)}</p>
        </div>
        <div class="hero-progress">
          <strong>{summary ? monthsUntilDueText(summary.monthsUntilDue) : "—"}</strong>
          {summary && <span class={HEALTH_STATUS_CLASS[summary.status]}>{summary.statusLabel || HEALTH_STATUS_FALLBACK_LABEL[summary.status]}</span>}
        </div>
      </div>
      <div class="table-card section-title">
        <table>
          <thead><tr><th>健檢日期</th><th>機構</th><th>項目</th><th>備註</th></tr></thead>
          <tbody>
            {(data?.healthChecks ?? []).map((record) => (
              <tr key={record.id}>
                <td>{record.checkDate}</td>
                <td>{record.institution || "—"}</td>
                <td><div class="chip-list">{record.items.map((item) => <span class={item.result === "abnormal" ? "result-abnormal" : item.result === "follow_up" ? "result-follow-up" : ""} key={item.id}>{item.itemName}・{item.resultLabel}{item.notes ? `（${item.notes}）` : ""}</span>)}</div></td>
                <td>{record.notes || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.healthChecks.length === 0 && <div class="empty-state">目前沒有健檢紀錄。</div>}
      </div>
    </section>
  );
}
