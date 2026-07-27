import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { message: string; details?: unknown };
}

interface ReportFilters {
  department: string | null;
  grade: string | null;
  startMonth: string;
  endMonth: string;
  startDate: string;
  endDate: string;
  endDateExclusive: string;
}

interface ReportEnvelope<T> {
  filters: ReportFilters;
  data: T;
}

interface Headcount {
  asOfDate: string;
  total: number;
  startTotal: number;
  netChange: number;
  byDepartment: Array<{ department: string; count: number }>;
  byGrade: Array<{ grade: string; count: number }>;
}

interface Turnover {
  terminations: number;
  startHeadcount: number;
  endHeadcount: number;
  averageHeadcount: number;
  turnoverRate: number;
  byDepartment: Array<{ department: string; terminations: number }>;
  byMonth: Array<{ month: string; terminations: number }>;
}

interface AttendanceBucket {
  records: number;
  absenceHours: number;
  overtimeHours: number;
}

interface AttendanceReport {
  totals: AttendanceBucket & { employees: number };
  byMonth: Array<AttendanceBucket & { month: string }>;
  byDepartment: Array<AttendanceBucket & { department: string }>;
  bySource: Array<AttendanceBucket & { source: string }>;
  byAbsenceType: Array<{ absenceType: string | null; records: number; absenceHours: number }>;
}

interface Funnel {
  stages: Array<{ stage: string; label: string; currentCount: number; enteredCount: number }>;
  rejectedCount: number;
  gradeFilterApplied: boolean;
}

interface CompletionSummary {
  employees: number;
  requiredTotal: number;
  completedTotal: number;
  completionRate: number;
  fullyCompleted: number;
}

interface Completion {
  asOfDate: string;
  company: CompletionSummary;
  byDepartment: Array<CompletionSummary & { department: string }>;
}

interface SalaryCost {
  asOfDate: string;
  headcount: number;
  totalSalary: number;
  averageSalary: number;
  missingSalaryCount: number;
  byDepartment: Array<{ department: string; headcount: number; totalSalary: number }>;
  byGrade: Array<{ grade: string; headcount: number; totalSalary: number }>;
}

const ENDPOINTS = [
  "headcount",
  "turnover",
  "attendance",
  "recruitment-funnel",
  "training-completion",
  "salary-cost",
  "summary",
];

let adminCookie = "";
let employeeCookie = "";

async function call<T>(path: string, init?: RequestInit): Promise<{
  response: Response;
  body: Envelope<T>;
}> {
  const response = await exports.default.fetch(`https://example.com${path}`, init);
  return { response, body: await response.json<Envelope<T>>() };
}

function adminJson(method: string, body: object): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify(body),
  };
}

async function loginAndChange(email: string, newPassword: string): Promise<string> {
  const login = await call("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Demo1234!" }),
  });
  expect(login.response.status).toBe(200);
  const cookie = login.response.headers.get("set-cookie")?.split(";")[0] ?? "";
  const changed = await call("/api/auth/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ currentPassword: "Demo1234!", newPassword }),
  });
  expect(changed.response.status).toBe(200);
  return cookie;
}

/** 種子資料以 SQLite date('now', ...) 產生，故測試同樣以 UTC 月份推算。 */
function monthOffset(offset: number): string {
  const now = new Date();
  const value = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
}

function period(startOffset: number, endOffset: number): string {
  return `?startMonth=${monthOffset(startOffset)}&endMonth=${monthOffset(endOffset)}`;
}

async function fetchReport<T>(name: string, query = ""): Promise<ReportEnvelope<T>> {
  const result = await call<ReportEnvelope<T>>(`/api/admin/reports/${name}${query}`, {
    headers: { Cookie: adminCookie },
  });
  expect(result.response.status).toBe(200);
  const payload = result.body.data;
  if (!payload) throw new Error(`報表 ${name} 未回傳資料。`);
  return payload;
}

beforeAll(async () => {
  adminCookie = await loginAndChange("admin@demo.local", "AdminM4Changed1234!");
  employeeCookie = await loginAndChange("chiahao.lin@demo.local", "EmployeeM4Changed1234!");
});

describe("M4 報表指標", () => {
  it("在職人數與人力結構以期末為基準，並附期初人數對照", async () => {
    const report = await fetchReport<Headcount>("headcount", period(5, 0));
    expect(report.data.total).toBe(12);
    expect(report.data.startTotal).toBe(15);
    expect(report.data.netChange).toBe(-3);
    expect(report.data.byDepartment).toHaveLength(3);
    expect(report.data.byDepartment.every((item) => item.count === 4)).toBe(true);
    expect(report.data.byGrade.reduce((sum, item) => sum + item.count, 0)).toBe(12);
    expect(report.data.asOfDate).toBe(report.filters.endDate);
  });

  it("離職率＝期間內離職數 ÷ 期初期末平均在職數", async () => {
    const report = await fetchReport<Turnover>("turnover", period(5, 0));
    expect(report.data.terminations).toBe(3);
    expect(report.data.startHeadcount).toBe(15);
    expect(report.data.endHeadcount).toBe(12);
    expect(report.data.averageHeadcount).toBe(13.5);
    expect(report.data.turnoverRate).toBe(22.22);
    expect(report.data.byMonth).toHaveLength(3);
    expect(report.data.byDepartment).toHaveLength(3);
  });

  it("缺勤與加班取自 attendance 表，並區分手動與 CSV 來源", async () => {
    const report = await fetchReport<AttendanceReport>("attendance", period(5, 0));
    expect(report.data.totals.records).toBe(18);
    expect(report.data.totals.employees).toBe(5);
    expect(report.data.totals.absenceHours).toBe(94);
    expect(report.data.totals.overtimeHours).toBe(74);
    expect(report.data.byMonth).toHaveLength(6);

    const manual = report.data.bySource.find((item) => item.source === "manual");
    const csv = report.data.bySource.find((item) => item.source === "csv");
    expect(manual).toMatchObject({ records: 9, absenceHours: 58, overtimeHours: 46 });
    expect(csv).toMatchObject({ records: 9, absenceHours: 36, overtimeHours: 28 });

    const types = new Map(report.data.byAbsenceType.map((item) => [item.absenceType, item.absenceHours]));
    expect(types.get("事假")).toBe(18);
    expect(types.get("病假")).toBe(28);
    expect(types.get("特休")).toBe(48);
  });

  it("招募漏斗沿用 M3 統計，各階段曾進入數與現況數皆正確", async () => {
    const report = await fetchReport<Funnel>("recruitment-funnel", period(5, 0));
    expect(report.data.stages).toHaveLength(7);
    expect(report.data.gradeFilterApplied).toBe(false);
    const entered = new Map(report.data.stages.map((item) => [item.stage, item.enteredCount]));
    const current = new Map(report.data.stages.map((item) => [item.stage, item.currentCount]));
    expect(entered.get("applied")).toBe(4);
    expect(entered.get("screening")).toBe(3);
    expect(entered.get("interview")).toBe(2);
    expect(entered.get("offer")).toBe(1);
    expect(current.get("offer")).toBe(1);
    expect(report.data.rejectedCount).toBe(0);
  });

  it("教育訓練完成率以期末為截止日，完訓後數字即時反映", async () => {
    const before = await fetchReport<Completion>("training-completion", period(5, 0));
    expect(before.data.company.employees).toBe(12);
    expect(before.data.company.requiredTotal).toBe(60);
    // 43 來自 0009 種子的歷史完訓紀錄（人資行政部 11、診所事業部 16、醫院事業部 16）。
    expect(before.data.company.completedTotal).toBe(43);
    expect(before.data.byDepartment).toHaveLength(3);

    // 用 emp-014 而非 emp-002：0009 的歷史種子資料已讓 emp-002 完成全部 5 門
    // 必修課，若沿用 emp-002 會因 completionData 以 (employee_id, course_id)
    // 去重，「再完成一次 course-04」不會讓 completedTotal 變化，測不出「即時
    // 反映」的行為。emp-014 在種子中缺席了 course-04（見 0009 §1-5），仍有
    // 空間可以完成。
    const session = await call<{ id: string }>("/api/admin/course-sessions", adminJson("POST", {
      courseId: "course-04",
      sessionDate: `${monthOffset(2)}-10`,
      startTime: "09:00",
      endTime: "12:00",
      location: "A 教室",
      capacity: 5,
      notes: "",
      selectedEmployeeIds: ["emp-014"],
    }));
    expect(session.response.status).toBe(201);
    const attendance = await call(
      `/api/admin/course-sessions/${session.body.data?.id}/attendance`,
      adminJson("PUT", { records: [{ employeeId: "emp-014", status: "completed" }] }),
    );
    expect(attendance.response.status).toBe(200);

    const after = await fetchReport<Completion>("training-completion", period(5, 0));
    expect(after.data.company.completedTotal).toBe(44);
    expect(after.data.company.completionRate).toBe(73.33);
    const clinic = after.data.byDepartment.find((item) => item.department === "診所事業部");
    expect(clinic?.completedTotal).toBe(17);

    // 期末落在完訓之前時，以「截至期末」口徑不應計入這次新完成的紀錄；
    // 但 0009 種子中更早（-5～-3 個月）完成的歷史紀錄仍應計入。
    const asOfPast = await fetchReport<Completion>("training-completion", period(5, 3));
    expect(asOfPast.data.company.completedTotal).toBe(40);
  });

  it("薪資成本只加總期末在職者的薪資", async () => {
    const report = await fetchReport<SalaryCost>("salary-cost", period(5, 0));
    expect(report.data.headcount).toBe(12);
    expect(report.data.totalSalary).toBe(646000);
    expect(report.data.missingSalaryCount).toBe(0);
    expect(report.data.byDepartment).toHaveLength(3);
    expect(report.data.byGrade.reduce((sum, item) => sum + item.totalSalary, 0)).toBe(646000);

    // 期末落在三名離職者離職之前，三人仍應計入。
    const earlier = await fetchReport<SalaryCost>("salary-cost", period(5, 5));
    expect(earlier.data.headcount).toBe(15);
    expect(earlier.data.totalSalary).toBe(788000);
  });

  it("summary 一次回傳六項指標", async () => {
    const report = await fetchReport<{
      headcount: Headcount;
      turnover: Turnover;
      attendance: AttendanceReport;
      funnel: Funnel;
      completion: Completion;
      salaryCost: SalaryCost;
    }>("summary", period(5, 0));
    expect(report.data.headcount.total).toBe(12);
    expect(report.data.turnover.turnoverRate).toBe(22.22);
    expect(report.data.attendance.totals.absenceHours).toBe(94);
    expect(report.data.funnel.stages).toHaveLength(7);
    expect(report.data.completion.company.requiredTotal).toBe(60);
    expect(report.data.salaryCost.totalSalary).toBe(646000);
  });
});

describe("M4 通用篩選", () => {
  it("期間篩選生效：換一組起迄月份數字跟著變", async () => {
    const twoMonthsAgo = await fetchReport<AttendanceReport>("attendance", period(2, 2));
    expect(twoMonthsAgo.data.totals.records).toBe(3);
    expect(twoMonthsAgo.data.totals.absenceHours).toBe(24);
    expect(twoMonthsAgo.data.totals.overtimeHours).toBe(12);

    const threeMonthsAgo = await fetchReport<AttendanceReport>("attendance", period(3, 3));
    expect(threeMonthsAgo.data.totals.records).toBe(3);
    expect(threeMonthsAgo.data.totals.absenceHours).toBe(12);
    expect(threeMonthsAgo.data.totals.overtimeHours).toBe(16);

    const lastMonth = await fetchReport<Turnover>("turnover", period(1, 1));
    expect(lastMonth.data.terminations).toBe(1);
    expect(lastMonth.data.byMonth[0]?.month).toBe(monthOffset(1));
    expect(lastMonth.data.turnoverRate).toBeGreaterThan(0);

    // 招募漏斗以投遞時間界定期間，種子應徵都在當月，往前三個月應為空。
    const funnel = await fetchReport<Funnel>("recruitment-funnel", period(3, 3));
    expect(funnel.data.stages.every((stage) => stage.enteredCount === 0)).toBe(true);
  });

  it("部門篩選對人力結構、離職率與出缺勤同時生效", async () => {
    const query = `${period(5, 0)}&department=${encodeURIComponent("診所事業部")}`;
    const headcount = await fetchReport<Headcount>("headcount", query);
    expect(headcount.data.total).toBe(4);
    expect(headcount.data.startTotal).toBe(5);

    const turnover = await fetchReport<Turnover>("turnover", query);
    expect(turnover.data.terminations).toBe(1);
    expect(turnover.data.turnoverRate).toBe(22.22);

    const attendance = await fetchReport<AttendanceReport>("attendance", query);
    expect(attendance.data.totals.records).toBe(9);
    expect(attendance.data.totals.absenceHours).toBe(58);
    expect(attendance.data.totals.overtimeHours).toBe(28);
  });

  it("職等篩選對人力結構與薪資成本生效", async () => {
    // 在職 G4：emp-005、006、007、012；離職的 emp-011 同為 G4 但不計入。
    const query = `${period(5, 0)}&grade=G4`;
    const headcount = await fetchReport<Headcount>("headcount", query);
    expect(headcount.data.total).toBe(4);
    expect(headcount.data.byGrade).toHaveLength(1);
    expect(headcount.data.startTotal).toBe(5);

    const salary = await fetchReport<SalaryCost>("salary-cost", query);
    expect(salary.data.headcount).toBe(4);
    expect(salary.data.totalSalary).toBe(218000);
  });

  it("未指定月份時採用 settings 的預設回溯月數", async () => {
    const report = await fetchReport<Headcount>("headcount");
    const [year, month] = report.filters.endMonth.split("-").map(Number);
    const expectedStart = new Date(Date.UTC(year ?? 0, (month ?? 1) - 6, 1));
    expect(report.filters.startMonth).toBe(
      `${expectedStart.getUTCFullYear()}-${String(expectedStart.getUTCMonth() + 1).padStart(2, "0")}`,
    );
    expect(report.filters.startDate).toBe(`${report.filters.startMonth}-01`);
    expect(report.data.total).toBe(12);
  });

  it("月份格式錯誤或起迄顛倒時回友善錯誤訊息", async () => {
    const badFormat = await call("/api/admin/reports/headcount?startMonth=2026-13", {
      headers: { Cookie: adminCookie },
    });
    expect(badFormat.response.status).toBe(422);
    expect(badFormat.body.error?.message).toContain("YYYY-MM");

    const reversed = await call(
      `/api/admin/reports/headcount?startMonth=${monthOffset(0)}&endMonth=${monthOffset(3)}`,
      { headers: { Cookie: adminCookie } },
    );
    expect(reversed.response.status).toBe(422);
    expect(reversed.body.error?.message).toBe("起始月份不可晚於結束月份。");
  });

  it("找不到的報表路徑回 404", async () => {
    const missing = await call("/api/admin/reports/unknown", { headers: { Cookie: adminCookie } });
    expect(missing.response.status).toBe(404);
  });
});

describe("M4 權限", () => {
  it("employee 帳號打任一報表端點皆得 403", async () => {
    for (const endpoint of ENDPOINTS) {
      const result = await call(`/api/admin/reports/${endpoint}`, {
        headers: { Cookie: employeeCookie },
      });
      expect(result.response.status, endpoint).toBe(403);
    }
  });
});
