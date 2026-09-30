import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import {
  type WorkbenchBucket,
  type WorkbenchItem,
  type WorkbenchSource,
  type WorkbenchSourceState,
  type WorkbenchTarget,
  workbenchSummary,
} from "../../shared/workbench";

interface WorkbenchPayload {
  timezone: string;
  today: string;
  weekStart: string;
  weekEnd: string;
  weekLabel: string;
  items: WorkbenchItem[];
  sources: Record<WorkbenchSource, WorkbenchSourceState>;
  note: string;
}

const BUCKET_LABEL: Record<WorkbenchBucket, string> = {
  today: "今天",
  this_week: "本週",
  overdue: "逾期",
  later: "本週之後",
  past_unconfirmed: "場次已過、待核對",
  unset: "未設定期限／待補資料",
};

const SOURCE_LABEL: Record<WorkbenchSource, string> = {
  onboarding_missing: "到職缺件",
  course_session: "課程場次",
  certification_expiry: "證照到期",
};

const ALLOWED_TARGETS = new Set<WorkbenchTarget>([
  "recruitment/onboarding",
  "scheduling/attendance",
  "health/certifications",
  "schedule",
  "certifications",
]);

export function RoleWorkbench<T extends WorkbenchTarget>({ endpoint, onOpenTarget }: {
  endpoint: "/api/admin/workbench" | "/api/employee/workbench";
  onOpenTarget: (target: T) => void;
}) {
  const [payload, setPayload] = useState<WorkbenchPayload | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [requestId, setRequestId] = useState(0);

  useEffect(() => {
    let active = true;
    const current = requestId;
    setLoading(true);
    setError("");
    void api<WorkbenchPayload>(endpoint)
      .then((data) => {
        if (!active || current !== requestId) return;
        setPayload(data);
      })
      .catch((caught: unknown) => {
        if (!active || current !== requestId) return;
        setPayload(null);
        setError(caught instanceof Error ? caught.message : "工作台載入失敗。");
      })
      .finally(() => {
        if (active && current === requestId) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [endpoint, requestId]);

  const summary = payload
    ? workbenchSummary({ loading, error: null, items: payload.items, sources: payload.sources })
    : workbenchSummary({ loading, error: error || null, items: [], sources: null });

  return (
    <div class="panel section-title" data-workbench="role">
      <div class="panel-heading">
        <div>
          <h2>工作台</h2>
          <small>
            {payload
              ? `${payload.timezone}・今天 ${payload.today}・本週 ${payload.weekLabel}。今天也落在本週內，但一列只出現在一個分組。`
              : "依 Asia/Taipei 今天與週一至週日分組。"}
          </small>
        </div>
        <button class="secondary" type="button" onClick={() => setRequestId((value) => value + 1)} disabled={loading}>
          {loading ? "讀取中" : "重試"}
        </button>
      </div>
      {error && (
        <div class="alert error" role="alert">
          {summary.headline} {error}
        </div>
      )}
      {loading && !payload && !error && <div class="empty-state">{summary.headline}</div>}
      {payload && (
        <>
          <p>{payload.note}</p>
          <div class="chip-list">
            {(Object.keys(payload.sources) as WorkbenchSource[]).map((source) => {
              const state = payload.sources[source];
              const label = state.status === "error"
                ? "載入失敗"
                : state.status === "insufficient"
                  ? "資料不足"
                  : state.itemCount === 0
                    ? "無待辦"
                    : `${state.itemCount} 項`;
              return <span key={source}>{SOURCE_LABEL[source]}：{label}</span>;
            })}
          </div>
          {payload.items.length === 0 && <div class="empty-state">{summary.headline}</div>}
          {(["today", "this_week", "overdue", "past_unconfirmed", "unset", "later"] as WorkbenchBucket[]).map((bucket) => {
            const rows = payload.items.filter((item) => item.bucket === bucket);
            if (rows.length === 0) return null;
            return (
              <div key={bucket}>
                <h3>{BUCKET_LABEL[bucket]}</h3>
                <div class="card-list">
                  {rows.map((item) => (
                    <article class="list-card" key={item.id}>
                      <div>
                        <strong>{item.title}</strong>
                        <p>{item.reason}</p>
                        <small>期限：{item.dueDate ?? "未設定"}・{item.nextAction}</small>
                      </div>
                      {ALLOWED_TARGETS.has(item.target) ? (
                        <button type="button" class="secondary" onClick={() => onOpenTarget(item.target)}>
                          前往
                        </button>
                      ) : (
                        <span class="status missing">無可用頁面</span>
                      )}
                    </article>
                  ))}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
