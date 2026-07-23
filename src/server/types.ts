export type Role = "admin" | "employee";

export interface AuthUser {
  id: string;
  employeeId: string | null;
  email: string;
  role: Role;
  mustChangePassword: boolean;
  employeeName: string | null;
  department: string | null;
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
