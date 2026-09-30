export type Role = "admin" | "employee";

export interface User {
  id: string;
  employeeId: string | null;
  email: string;
  role: Role;
  mustChangePassword: boolean;
  employeeName: string | null;
  department: string | null;
  /** 是否已完成（或略過）新手導覽；false 時登入後會自動開啟導覽。 */
  tourCompleted: boolean;
}

export interface Course {
  id: string;
  name: string;
  competencyLevel: number;
  courseType: "mandatory" | "elective";
  durationHours: number;
  instructor: string;
  description: string;
  relatedCertificationId: string | null;
  relatedCertificationName: string | null;
  validityMonths: number | null;
  active: number;
  enrollmentOpen: number;
}

export interface CourseSession {
  id: string;
  courseId: string;
  courseName: string;
  competencyLevel: number;
  courseType: "mandatory" | "elective";
  sessionDate: string;
  startTime: string;
  endTime: string;
  location: string;
  capacity: number;
  notes: string;
  status: string;
  enrolledCount: number;
  attendanceStatus?: string;
}

export interface SpecialDay {
  id: string;
  specialDate: string;
  dayType: "blackout" | "mandatory_all";
  title: string;
  reason: string;
  courseSessionId: string | null;
}

export interface AssignmentEmployee {
  id: string;
  employeeNo: string;
  name: string;
  department: string;
  jobType: string;
  requiredLevel: number;
  recommended: boolean;
  conflicts: Array<{
    conflictingSessionId: string;
    courseName: string;
    startTime: string;
    endTime: string;
  }>;
}

export interface CompletionEmployee {
  id: string;
  employeeNo: string;
  name: string;
  department: string;
  jobType: string;
  requiredCount: number;
  completedCount: number;
  completionRate: number;
  missingCourses: Array<{ id: string; name: string; competencyLevel: number }>;
}

export interface TrainingSettings {
  certificationReminderDays: number;
  electiveEnrollmentRequiresApproval: boolean;
}

export interface MandatoryCourseStatus {
  courseId: string;
  courseName: string;
  competencyLevel: number;
  completed: boolean;
  completedAt: string | null;
  validUntil: string | null;
}

export interface MandatoryTrainingEmployee {
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  department: string;
  grade: string;
  jobType: string;
  requiredLevel: number;
  requiredCount: number;
  completedCount: number;
  completionRate: number;
  courses: MandatoryCourseStatus[];
}

export interface CertificationReminder {
  id: string;
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  department: string;
  certificationId: string;
  certificationName: string;
  issuer: string;
  certificateNumber: string | null;
  issuedAt: string;
  expiresAt: string;
  notes: string;
  daysUntilExpiry: number;
}

export interface EmployeeCertification {
  id: string;
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  department: string;
  certificationId: string;
  certificationName: string;
  issuer: string;
  certificateNumber: string | null;
  issuedAt: string;
  expiresAt: string | null;
  notes: string;
  daysUntilExpiry: number | null;
}

export interface CertificationType {
  id: string;
  name: string;
  issuer: string;
  defaultValidityMonths: number | null;
  active: number;
}

export type EmployeeStatus = "active" | "inactive";

export interface Employee {
  id: string;
  employeeNo: string;
  name: string;
  email: string;
  department: string;
  grade: string;
  title: string;
  jobTypeId: string;
  jobType: string;
  hireDate: string;
  /** 健檢頻率依年齡分級計算，沒有生日就無法分級（見 M6）。 */
  birthDate: string | null;
  terminationDate: string | null;
  status: EmployeeStatus;
  salary: number | null;
}

export interface JobTypeOption {
  id: string;
  name: string;
  requiredLevel: number;
}

// ---- 登入帳號生命週期管理（規格：員工管理頁內的帳號欄位與操作）----
// 對應後端 /api/admin/users 與 /api/admin/employees/{id}/responsibilities。
// 欄位名稱依主對話訂定的契約；細節（例如 create/reset-password 回應是否
// 內嵌 temporaryPassword、responsibilities 回應的確切形狀）在
// EmployeeAdminPages.tsx 內以防禦性寫法解析，待後端落地後再核對調整。
export interface AdminUserAccount {
  id: string;
  email: string;
  role: Role;
  active: boolean;
  mustChangePassword: boolean;
  employeeId: string | null;
  employeeName: string | null;
  employeeStatus: EmployeeStatus | null;
  auditRefCount: number;
}

export interface DeleteAccountResult {
  mode: "deleted" | "archived";
  auditRefCount: number;
  message?: string;
}

export interface EmployeeResponsibility {
  keyPositionId: string;
  keyPositionTitle: string;
  department: string;
  relation: "incumbent" | "successor";
  relationLabel?: string;
}

// ---- 系統設定／職務類型管理（規格 §七 Admin「系統設定」）----
// 對應後端 GET/PATCH /api/admin/settings 與 /api/admin/job-types（見 src/server）。

export type SettingValueType = "string" | "number" | "boolean" | "json";

export interface SettingItem {
  key: string;
  value: string;
  valueType: SettingValueType;
  description: string;
}

export interface JobType {
  id: string;
  name: string;
  requiredLevel: number;
  active: number;
  employeeCount?: number;
}

// ---- 員工「個人資料」頁（規格 §七 Employee 導覽）----
// 對應後端 GET/PATCH /api/employee/profile（見 src/server/m1.ts 的
// EmployeeProfileRecord）。回傳鍵為 `employee`。唯讀欄位（員工編號、部門、
// 職等、職稱、職務類型、到職日等）由 HR 於員工管理維護，此頁僅能改姓名與 email。
export interface EmployeeProfile {
  id: string;
  employeeNo: string;
  name: string;
  email: string;
  department: string;
  grade: string;
  title: string;
  jobTypeId: string;
  jobType: string;
  hireDate: string;
  terminationDate: string | null;
  status: "active" | "inactive";
}

export interface AttendanceRecord {
  id: string;
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  department: string;
  grade: string;
  attendanceDate: string;
  absenceHours: number;
  overtimeHours: number;
  absenceType: string | null;
  source: "manual" | "csv";
  notes: string;
}

export interface ImportRowError {
  row: number;
  message: string;
}

export interface ImportSummary {
  imported: number;
  updated: number;
  skipped: number;
  errors: ImportRowError[];
}

// ---- M6：員工健康檢查追蹤（對應 src/server/health.ts＋router.ts）----
// 後端與本檔為平行開發；此處欄位已對照 src/server/health.ts 的實際回傳鍵名
// 核對過（非猜測）。健檢頻率依《勞工健康保護規則》年齡分級 on-read 計算：
// 未滿 40 歲每 5 年、40–65 歲每 3 年、65 歲以上每年；沒有生日則無法分級，
// 歸類為 missing_birth_date（第五種狀態，需請 HR 補登生日）。
export type HealthCheckStatus = "overdue" | "due_soon" | "ok" | "never" | "missing_birth_date";

export interface HealthCheckDueEntry {
  employeeId: string;
  employeeNo: string;
  name: string;
  department: string;
  birthDate: string | null;
  hireDate: string;
  lastCheckDate: string | null;
  age: number | null;
  intervalMonths: number | null;
  nextDueDate: string | null;
  monthsUntilDue: number | null;
  status: HealthCheckStatus;
  statusLabel: string;
  /** 從未健檢者的應檢日以到職日為基準推算。 */
  dueBasis: "last_check" | "hire_date" | "unknown";
}

export interface HealthCheckDueListPayload {
  reminderMonths: number;
  windowMonths: number;
  employees: HealthCheckDueEntry[];
}

export interface HealthCheckItem {
  id: string;
  name: string;
  category: string;
  required: number;
  active: number;
  sortOrder: number;
}

export type HealthCheckResultValue = "normal" | "abnormal" | "follow_up" | "pending";

export interface HealthCheckResultItem {
  id: string;
  itemId: string;
  itemName: string;
  category: string;
  itemActive: number;
  result: HealthCheckResultValue;
  resultLabel: string;
  notes: string;
}

export interface HealthCheckRecord {
  id: string;
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  department: string;
  checkDate: string;
  institution: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  items: HealthCheckResultItem[];
}

export interface EmployeeHealthChecksPayload {
  reminderMonths: number;
  summary: HealthCheckDueEntry | null;
  healthChecks: HealthCheckRecord[];
}

/** GET /api/admin/data-quality。dueDate 固定 null，缺資料不是逾期。 */
export interface DataQualityItem {
  id: string;
  entityType: "employee" | "user";
  entityId: string;
  field: "birth_date" | "department" | "employee_id";
  reason: string;
  impact: string;
  nextAction: { tab: "employees" | "settings" };
  dueDate: null;
}
