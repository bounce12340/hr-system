export type Role = "admin" | "employee";

export interface User {
  id: string;
  employeeId: string | null;
  email: string;
  role: Role;
  mustChangePassword: boolean;
  employeeName: string | null;
  department: string | null;
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
