export type Role = "admin" | "employee";

export interface AuthUser {
  id: string;
  employeeId: string | null;
  email: string;
  role: Role;
  mustChangePassword: boolean;
  employeeName: string | null;
  department: string | null;
  /** 是否已完成（或主動略過）新手導覽。false 時前端會在登入後自動開啟導覽。 */
  tourCompleted: boolean;
}

export interface ApiContext {
  request: Request;
  env: Env;
  url: URL;
  user: AuthUser | null;
}

export interface RouteMatch {
  id?: string;
}
