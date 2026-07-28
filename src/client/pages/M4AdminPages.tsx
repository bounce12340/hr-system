import { useEffect, useState } from "preact/hooks";
import type { ChartConfiguration } from "chart.js";
import { api } from "../api";
import { Chart } from "../components/Chart";
import { Field } from "../components/FieldHelp";
import { exportCsv, exportXlsx } from "../download";
import type { SheetRow } from "../export";

// ---- 後端回傳型別，對應 src/server/m4.ts 六項指標與 summary 端點 ----

interface ResolvedFilters {
  department: string | null;
  grade: string | null;
  startMonth: string;
  endMonth: string;
  startDate: string;
  endDate: string;
  endDateExclusive: string;
}

interface DepartmentCount { department: string; count: number; }
interface GradeCount { grade: string; count: number; }

interface HeadcountData {
  asOfDate: string;
  total: number;
  startTotal: number;
  netChange: number;
  byDepartment: DepartmentCount[];
  byGrade: GradeCount[];
}

interface TurnoverData {
  terminations: number;
  startHeadcount: number;
  endHeadcount: number;
  averageHeadcount: number;
  turnoverRate: number;
  byDepartment: Array<{ department: string; terminations: number }>;
  byMonth: Array<{ month: string; terminations: number }>;
}

interface AttendanceBucket { records: number; absenceHours: number; overtimeHours: number; }
interface AttendanceData {
  totals: { records: number; employees: number; absenceHours: number; overtimeHours: number };
  byMonth: Array<AttendanceBucket & { month: string }>;
  byDepartment: Array<AttendanceBucket & { department: string }>;
  bySource: Array<AttendanceBucket & { source: string }>;
  byAbsenceType: Array<{ absenceType: string | null; records: number; absenceHours: number }>;
}

interface FunnelStageRow { stage: string; label: string; currentCount: number; enteredCount: number; }
interface FunnelData { stages: FunnelStageRow[]; rejectedCount: number; gradeFilterApplied: boolean; }

interface CompletionSummary {
  employees: number;
  requiredTotal: number;
  completedTotal: number;
  completionRate: number;
  fullyCompleted: number;
}
interface CompletionData { asOfDate: string; company: CompletionSummary; byDepartment: Array<CompletionSummary & { department: string }>; }

interface SalaryBucket { headcount: number; totalSalary: number; }
interface SalaryData {
  asOfDate: string;
  headcount: number;
  totalSalary: number;
  averageSalary: number;
  missingSalaryCount: number;
  byDepartment: Array<SalaryBucket & { department: string }>;
  byGrade: Array<SalaryBucket & { grade: string }>;
}

interface SummaryData {
  headcount: HeadcountData;
  turnover: TurnoverData;
  attendance: AttendanceData;
  funnel: FunnelData;
  completion: CompletionData;
  salaryCost: SalaryData;
}

interface SummaryResponse { filters: ResolvedFilters; data: SummaryData; }

interface FilterState {
  department: string;
  grade: string;
  startMonth: string;
  endMonth: string;
}

const SOURCE_LABEL: Record<string, string> = { manual: "人工登錄", csv: "CSV 匯入" };

const numberFormatter = new Intl.NumberFormat("zh-TW");
function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

function buildQuery(filters: FilterState): string {
  const params = new URLSearchParams();
  if (filters.department) params.set("department", filters.department);
  if (filters.grade) params.set("grade", filters.grade);
  if (filters.startMonth) params.set("startMonth", filters.startMonth);
  if (filters.endMonth) params.set("endMonth", filters.endMonth);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function reportFilename(key: string, filters: ResolvedFilters): string {
  return `report-${key}-${filters.startMonth}_${filters.endMonth}`;
}

function periodLabel(filters: ResolvedFilters): string {
  return `${filters.startMonth} ～ ${filters.endMonth}`;
}

const BAR_COLOR = "#1d675d";
const BAR_COLOR_ALT = "#d66b35";
const BAR_COLOR_MUTED = "#bcd9d0";

interface BarSeries { label: string; data: number[]; color: string; }

/** 建立長條圖設定：horizontal 為 true 時畫水平長條（indexAxis: "y"），用於漏斗這類階段較多的資料。 */
function buildBarConfig(labels: string[], series: BarSeries[], horizontal = false): ChartConfiguration<"bar"> {
  const datasets = series.map((item) => ({
    label: item.label,
    data: item.data,
    backgroundColor: item.color,
    borderRadius: 4,
    maxBarThickness: 34,
  }));
  const valueScale = { beginAtZero: true };
  return {
    type: "bar",
    data: { labels, datasets },
    options: {
      indexAxis: horizontal ? "y" : "x",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: series.length > 1, position: "bottom" },
      },
      scales: horizontal ? { x: valueScale } : { y: valueScale },
    },
  };
}

function Message({ text, error = false }: { text: string; error?: boolean }) {
  if (!text) return null;
  return <div class={`alert ${error ? "error" : "success"}`}>{text}</div>;
}

function ReportFilterBar({
  filters,
  displayStartMonth,
  displayEndMonth,
  departmentOptions,
  gradeOptions,
  onChange,
}: {
  filters: FilterState;
  displayStartMonth: string;
  displayEndMonth: string;
  departmentOptions: string[];
  gradeOptions: string[];
  onChange: (patch: Partial<FilterState>) => void;
}) {
  return (
    <div class="report-filter-bar">
      <label>
        部門
        <select value={filters.department} onChange={(event) => onChange({ department: event.currentTarget.value })}>
          <option value="">全部部門</option>
          {departmentOptions.map((item) => <option value={item} key={item}>{item}</option>)}
        </select>
      </label>
      <label>
        職等
        <select value={filters.grade} onChange={(event) => onChange({ grade: event.currentTarget.value })}>
          <option value="">全部職等</option>
          {gradeOptions.map((item) => <option value={item} key={item}>{item}</option>)}
        </select>
      </label>
      <Field
        label="起始月份"
        help={<>統計期間的起點，<strong>含當月</strong>。離職率的分母會取期初與期末在職人數的平均，
          因此期間長短會改變分母，不只是改變篩選範圍。</>}
      >
        <input
          type="month"
          value={displayStartMonth}
          onInput={(event) => onChange({ startMonth: event.currentTarget.value })}
        />
      </Field>
      <Field
        label="結束月份"
        help={<>統計期間的終點。<strong>離職日當天不計入在職</strong>——當月最後一天離職的人，
          會算進離職數而不算進期末在職人數。</>}
      >
        <input
          type="month"
          value={displayEndMonth}
          onInput={(event) => onChange({ endMonth: event.currentTarget.value })}
        />
      </Field>
    </div>
  );
}

function ReportCardHead({
  title,
  description,
  period,
  onExportCsv,
  onExportXlsx,
}: {
  title: string;
  description: string;
  period: string;
  onExportCsv: () => void;
  onExportXlsx: () => void;
}) {
  return (
    <div class="report-card-head">
      <div>
        <p class="eyebrow">M4 REPORTS</p>
        <h2>{title}</h2>
        <p>{description}期間 {period}</p>
      </div>
      <div class="report-export">
        <button class="secondary" onClick={onExportCsv}>匯出 CSV</button>
        <button class="secondary" onClick={onExportXlsx}>匯出 XLSX</button>
      </div>
    </div>
  );
}

function HeadcountReportCard({ data, filters }: { data: HeadcountData; filters: ResolvedFilters }) {
  const filename = reportFilename("headcount", filters);
  const rows: SheetRow[] = [
    ["指標", "數值"],
    ["在職人數（期末）", data.total],
    ["期初人數", data.startTotal],
    ["期間淨變動", data.netChange],
    [],
    ["部門", "人數"],
    ...data.byDepartment.map((item): SheetRow => [item.department, item.count]),
    [],
    ["職等", "人數"],
    ...data.byGrade.map((item): SheetRow => [item.grade, item.count]),
  ];
  return (
    <article class="report-card">
      <ReportCardHead
        title="在職人數與人力結構"
        description="依部門與職等呈現在職人力分佈（期末快照）。"
        period={periodLabel(filters)}
        onExportCsv={() => exportCsv(`${filename}.csv`, rows)}
        onExportXlsx={() => exportXlsx(`${filename}.xlsx`, "人力結構", rows)}
      />
      <div class="metric-row">
        <div class="metric accent"><span>在職人數（期末）</span><strong>{formatNumber(data.total)}</strong></div>
        <div class="metric"><span>期初人數</span><strong>{formatNumber(data.startTotal)}</strong></div>
        <div class="metric"><span>期間淨變動</span><strong>{data.netChange > 0 ? "+" : ""}{formatNumber(data.netChange)}</strong></div>
      </div>
      <div class="chart-grid">
        <div class="chart-block">
          <h3>部門人力分佈</h3>
          <Chart
            ariaLabel="各部門在職人數長條圖"
            config={buildBarConfig(data.byDepartment.map((item) => item.department), [
              { label: "人數", data: data.byDepartment.map((item) => item.count), color: BAR_COLOR },
            ])}
          />
        </div>
        <div class="chart-block">
          <h3>職等人力分佈</h3>
          <Chart
            ariaLabel="各職等在職人數長條圖"
            config={buildBarConfig(data.byGrade.map((item) => item.grade), [
              { label: "人數", data: data.byGrade.map((item) => item.count), color: BAR_COLOR_ALT },
            ])}
          />
        </div>
      </div>
    </article>
  );
}

function TurnoverReportCard({ data, filters }: { data: TurnoverData; filters: ResolvedFilters }) {
  const filename = reportFilename("turnover", filters);
  const rows: SheetRow[] = [
    ["指標", "數值"],
    ["離職率（%）", data.turnoverRate],
    ["離職人數", data.terminations],
    ["期初在職", data.startHeadcount],
    ["期末在職", data.endHeadcount],
    ["平均在職", data.averageHeadcount],
    [],
    ["部門", "離職人數"],
    ...data.byDepartment.map((item): SheetRow => [item.department, item.terminations]),
    [],
    ["月份", "離職人數"],
    ...data.byMonth.map((item): SheetRow => [item.month, item.terminations]),
  ];
  return (
    <article class="report-card">
      <ReportCardHead
        title="離職率"
        description="期間內離職人數與離職率（平均在職數＝期初期末平均）。"
        period={periodLabel(filters)}
        onExportCsv={() => exportCsv(`${filename}.csv`, rows)}
        onExportXlsx={() => exportXlsx(`${filename}.xlsx`, "離職率", rows)}
      />
      <div class="metric-row">
        <div class="metric accent"><span>離職率</span><strong>{data.turnoverRate}%</strong></div>
        <div class="metric"><span>離職人數</span><strong>{formatNumber(data.terminations)}</strong></div>
        <div class="metric"><span>期初在職</span><strong>{formatNumber(data.startHeadcount)}</strong></div>
        <div class="metric"><span>期末在職</span><strong>{formatNumber(data.endHeadcount)}</strong></div>
      </div>
      <div class="chart-block">
        <h3>各月離職人數</h3>
        <Chart
          ariaLabel="各月離職人數長條圖"
          config={buildBarConfig(data.byMonth.map((item) => item.month), [
            { label: "離職人數", data: data.byMonth.map((item) => item.terminations), color: BAR_COLOR },
          ])}
        />
      </div>
      <div class="table-card section-title">
        <table>
          <thead><tr><th>部門</th><th>離職人數</th></tr></thead>
          <tbody>
            {data.byDepartment.map((item) => (
              <tr key={item.department}><td>{item.department}</td><td>{item.terminations}</td></tr>
            ))}
            {data.byDepartment.length === 0 && (
              <tr><td colSpan={2}><div class="empty-state">期間內無離職紀錄。</div></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function AttendanceReportCard({ data, filters }: { data: AttendanceData; filters: ResolvedFilters }) {
  const filename = reportFilename("attendance", filters);
  const rows: SheetRow[] = [
    ["指標", "數值"],
    ["總筆數", data.totals.records],
    ["涉及人數", data.totals.employees],
    ["缺勤時數", data.totals.absenceHours],
    ["加班時數", data.totals.overtimeHours],
    [],
    ["月份", "筆數", "缺勤時數", "加班時數"],
    ...data.byMonth.map((item): SheetRow => [item.month, item.records, item.absenceHours, item.overtimeHours]),
    [],
    ["部門", "筆數", "缺勤時數", "加班時數"],
    ...data.byDepartment.map((item): SheetRow => [item.department, item.records, item.absenceHours, item.overtimeHours]),
    [],
    ["來源", "筆數", "缺勤時數", "加班時數"],
    ...data.bySource.map((item): SheetRow => [
      SOURCE_LABEL[item.source] ?? item.source, item.records, item.absenceHours, item.overtimeHours,
    ]),
    [],
    ["請假類別", "筆數", "缺勤時數"],
    ...data.byAbsenceType.map((item): SheetRow => [item.absenceType ?? "未分類（純加班）", item.records, item.absenceHours]),
  ];
  return (
    <article class="report-card">
      <ReportCardHead
        title="缺勤與加班統計"
        description="期間內缺勤與加班時數彙總（涵蓋人工登錄與 CSV 匯入）。"
        period={periodLabel(filters)}
        onExportCsv={() => exportCsv(`${filename}.csv`, rows)}
        onExportXlsx={() => exportXlsx(`${filename}.xlsx`, "缺勤與加班統計", rows)}
      />
      <div class="metric-row">
        <div class="metric"><span>總筆數</span><strong>{formatNumber(data.totals.records)}</strong></div>
        <div class="metric"><span>涉及人數</span><strong>{formatNumber(data.totals.employees)}</strong></div>
        <div class="metric accent"><span>缺勤時數</span><strong>{formatNumber(data.totals.absenceHours)}</strong></div>
        <div class="metric accent"><span>加班時數</span><strong>{formatNumber(data.totals.overtimeHours)}</strong></div>
      </div>
      <div class="chart-block">
        <h3>各月缺勤與加班時數</h3>
        <Chart
          ariaLabel="各月缺勤與加班時數長條圖"
          config={buildBarConfig(data.byMonth.map((item) => item.month), [
            { label: "缺勤時數", data: data.byMonth.map((item) => item.absenceHours), color: BAR_COLOR_ALT },
            { label: "加班時數", data: data.byMonth.map((item) => item.overtimeHours), color: BAR_COLOR },
          ])}
        />
      </div>
      <div class="table-card section-title">
        <table>
          <thead><tr><th>部門</th><th>筆數</th><th>缺勤時數</th><th>加班時數</th></tr></thead>
          <tbody>
            {data.byDepartment.map((item) => (
              <tr key={item.department}>
                <td>{item.department}</td><td>{item.records}</td><td>{item.absenceHours}</td><td>{item.overtimeHours}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="chip-list section-title">
        {data.byAbsenceType.map((item) => (
          <span key={item.absenceType ?? "none"}>{item.absenceType ?? "未分類（純加班）"}：{item.absenceHours} 小時</span>
        ))}
        {data.byAbsenceType.length === 0 && <span class="done-chip">期間內無缺勤紀錄</span>}
      </div>
    </article>
  );
}

function FunnelReportCard({ data, filters }: { data: FunnelData; filters: ResolvedFilters }) {
  const filename = reportFilename("recruitment-funnel", filters);
  const applied = data.stages.find((stage) => stage.stage === "applied");
  const onboarded = data.stages.find((stage) => stage.stage === "onboarded");
  const rows: SheetRow[] = [
    ["階段", "目前人數", "累計進入人數"],
    ...data.stages.map((item): SheetRow => [item.label, item.currentCount, item.enteredCount]),
    [],
    ["淘汰人數", data.rejectedCount],
  ];
  return (
    <article class="report-card">
      <ReportCardHead
        title="招募漏斗"
        description="以投遞時間界定期間，呈現各階段轉換情形；職等篩選不適用。"
        period={periodLabel(filters)}
        onExportCsv={() => exportCsv(`${filename}.csv`, rows)}
        onExportXlsx={() => exportXlsx(`${filename}.xlsx`, "招募漏斗", rows)}
      />
      <div class="metric-row">
        <div class="metric accent"><span>期間投遞總數</span><strong>{formatNumber(applied?.enteredCount ?? 0)}</strong></div>
        <div class="metric"><span>到職人數</span><strong>{formatNumber(onboarded?.currentCount ?? 0)}</strong></div>
        <div class="metric"><span>淘汰人數</span><strong>{formatNumber(data.rejectedCount)}</strong></div>
      </div>
      <div class="chart-block">
        <h3>各階段人數</h3>
        <Chart
          height={280}
          ariaLabel="招募漏斗各階段人數長條圖"
          config={buildBarConfig(
            data.stages.map((item) => item.label),
            [
              { label: "累計進入", data: data.stages.map((item) => item.enteredCount), color: BAR_COLOR_MUTED },
              { label: "目前人數", data: data.stages.map((item) => item.currentCount), color: BAR_COLOR },
            ],
            true,
          )}
        />
      </div>
    </article>
  );
}

function CompletionReportCard({ data, filters }: { data: CompletionData; filters: ResolvedFilters }) {
  const filename = reportFilename("training-completion", filters);
  const rows: SheetRow[] = [
    ["指標", "數值"],
    ["在職人數", data.company.employees],
    ["應完成項目", data.company.requiredTotal],
    ["已完成項目", data.company.completedTotal],
    ["完成率（%）", data.company.completionRate],
    ["全數完成人數", data.company.fullyCompleted],
    [],
    ["部門", "在職人數", "應完成", "已完成", "完成率（%）", "全數完成人數"],
    ...data.byDepartment.map((item): SheetRow => [
      item.department, item.employees, item.requiredTotal, item.completedTotal, item.completionRate, item.fullyCompleted,
    ]),
  ];
  return (
    <article class="report-card">
      <ReportCardHead
        title="教育訓練完成率"
        description={`截至 ${data.asOfDate} 的累計必修完成狀態（只吃迄月，起始月份不影響本報表）。`}
        period={periodLabel(filters)}
        onExportCsv={() => exportCsv(`${filename}.csv`, rows)}
        onExportXlsx={() => exportXlsx(`${filename}.xlsx`, "教育訓練完成率", rows)}
      />
      <div class="metric-row">
        <div class="metric"><span>在職人數</span><strong>{formatNumber(data.company.employees)}</strong></div>
        <div class="metric"><span>應完成項目</span><strong>{formatNumber(data.company.requiredTotal)}</strong></div>
        <div class="metric"><span>已完成項目</span><strong>{formatNumber(data.company.completedTotal)}</strong></div>
        <div class="metric accent"><span>完成率</span><strong>{data.company.completionRate}%</strong></div>
      </div>
      <div class="table-card section-title">
        <table>
          <thead><tr><th>部門</th><th>在職人數</th><th>完成進度</th><th>完成率</th><th>全數完成</th></tr></thead>
          <tbody>
            {data.byDepartment.map((item) => (
              <tr key={item.department}>
                <td>{item.department}</td>
                <td>{item.employees}</td>
                <td>{item.completedTotal}/{item.requiredTotal}</td>
                <td>
                  <div class="progress-cell">
                    <div class="progress"><span style={{ width: `${item.completionRate}%` }} /></div>
                    <b>{item.completionRate}%</b>
                  </div>
                </td>
                <td>{item.fullyCompleted}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function SalaryCostReportCard({ data, filters }: { data: SalaryData; filters: ResolvedFilters }) {
  const filename = reportFilename("salary-cost", filters);
  const rows: SheetRow[] = [
    ["指標", "數值"],
    ["在職人數", data.headcount],
    ["薪資總額", data.totalSalary],
    ["平均薪資", data.averageSalary],
    ["薪資缺漏人數", data.missingSalaryCount],
    [],
    ["部門", "人數", "薪資總額"],
    ...data.byDepartment.map((item): SheetRow => [item.department, item.headcount, item.totalSalary]),
    [],
    ["職等", "人數", "薪資總額"],
    ...data.byGrade.map((item): SheetRow => [item.grade, item.headcount, item.totalSalary]),
  ];
  return (
    <article class="report-card">
      <ReportCardHead
        title="薪資成本"
        description={`截至 ${data.asOfDate} 期末仍在職者的月薪加總（只吃迄月，不含期間內離職者）。`}
        period={periodLabel(filters)}
        onExportCsv={() => exportCsv(`${filename}.csv`, rows)}
        onExportXlsx={() => exportXlsx(`${filename}.xlsx`, "薪資成本", rows)}
      />
      <div class="metric-row">
        <div class="metric"><span>在職人數</span><strong>{formatNumber(data.headcount)}</strong></div>
        <div class="metric accent"><span>薪資總額</span><strong>{formatNumber(data.totalSalary)}</strong></div>
        <div class="metric"><span>平均薪資</span><strong>{formatNumber(data.averageSalary)}</strong></div>
        <div class="metric"><span>薪資缺漏人數</span><strong>{formatNumber(data.missingSalaryCount)}</strong></div>
      </div>
      <div class="chart-block">
        <h3>各部門薪資總額</h3>
        <Chart
          ariaLabel="各部門薪資總額長條圖"
          config={buildBarConfig(data.byDepartment.map((item) => item.department), [
            { label: "薪資總額", data: data.byDepartment.map((item) => item.totalSalary), color: BAR_COLOR },
          ])}
        />
      </div>
      <div class="table-card section-title">
        <table>
          <thead><tr><th>職等</th><th>人數</th><th>薪資總額</th><th>平均薪資</th></tr></thead>
          <tbody>
            {data.byGrade.map((item) => (
              <tr key={item.grade}>
                <td>{item.grade}</td>
                <td>{item.headcount}</td>
                <td>{formatNumber(item.totalSalary)}</td>
                <td>{formatNumber(item.headcount > 0 ? Math.round(item.totalSalary / item.headcount) : 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}

export function ReportsPage() {
  const [filters, setFilters] = useState<FilterState>({ department: "", grade: "", startMonth: "", endMonth: "" });
  const [departmentOptions, setDepartmentOptions] = useState<string[]>([]);
  const [gradeOptions, setGradeOptions] = useState<string[]>([]);
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  // 篩選下拉選單的選項只需公司全貌一次即可，不隨使用者目前選取的篩選變動。
  useEffect(() => {
    api<{ data: HeadcountData }>("/api/admin/reports/headcount")
      .then((result) => {
        setDepartmentOptions(result.data.byDepartment.map((item) => item.department));
        setGradeOptions(result.data.byGrade.map((item) => item.grade));
      })
      .catch(() => {
        // 選項讀取失敗不影響報表本體，下拉選單維持空白（僅剩「全部」可選）即可。
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    api<SummaryResponse>(`/api/admin/reports/summary${buildQuery(filters)}`)
      .then((result) => {
        if (!cancelled) setSummary(result);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "無法讀取報表資料。");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters.department, filters.grade, filters.startMonth, filters.endMonth]);

  const displayStartMonth = filters.startMonth || summary?.filters.startMonth || "";
  const displayEndMonth = filters.endMonth || summary?.filters.endMonth || "";

  return (
    <section>
      <div class="page-heading">
        <div>
          <p class="eyebrow">M4 REPORTS</p>
          <h1>報表中心</h1>
          <p>在職人力、離職率、缺勤加班、招募漏斗、教育訓練完成率與薪資成本，六項指標一次掌握。</p>
        </div>
      </div>
      <Message text={error} error />
      <ReportFilterBar
        filters={filters}
        displayStartMonth={displayStartMonth}
        displayEndMonth={displayEndMonth}
        departmentOptions={departmentOptions}
        gradeOptions={gradeOptions}
        onChange={(patch) => setFilters((current) => ({ ...current, ...patch }))}
      />
      {loading && !summary && <div class="empty-state">載入報表中…</div>}
      {summary && (
        <div class="report-stack">
          <HeadcountReportCard data={summary.data.headcount} filters={summary.filters} />
          <TurnoverReportCard data={summary.data.turnover} filters={summary.filters} />
          <AttendanceReportCard data={summary.data.attendance} filters={summary.filters} />
          <FunnelReportCard data={summary.data.funnel} filters={summary.filters} />
          <CompletionReportCard data={summary.data.completion} filters={summary.filters} />
          <SalaryCostReportCard data={summary.data.salaryCost} filters={summary.filters} />
        </div>
      )}
    </section>
  );
}
