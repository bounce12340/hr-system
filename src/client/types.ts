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
