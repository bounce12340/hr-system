/**
 * 管理端資料品質待補清單。只列出既有規則「算不出」的缺口，不補值、不寫入。
 *
 * 不列入：
 * - job_type_id：employees.job_type_id 為 NOT NULL REFERENCES job_types(id)，
 *   且 SQLite 預設 foreign_keys 對既有列沒有可觀察的懸空參照路徑可在此端點修補。
 *   停用職務類型仍能 JOIN 出 required_level（見 m2 mandatoryTraining），不算「算不出」。
 * - hire_date：employees.hire_date TEXT NOT NULL。寫入路徑用 isoDate／strictIsoDate
 *   拒絕空值與非法日期。空字串與 NULL 被 schema 擋下，不在此假造缺口。
 *
 * 生日缺口沿用 health.ts 的 missing_birth_date：NULL 或空白都無法計算年齡級距。
 * 帳號缺口沿用 requireEmployeeIdentity：employee_id 為 NULL 且未封存時，員工端 API 403。
 * 不建議依 email 自動綁定。
 */

import { json } from "./http";
import type { ApiContext } from "./types";

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

interface EmployeeGapRow {
  id: string;
  birthDate: string | null;
  department: string;
}

interface UserGapRow {
  id: string;
}

const BIRTH_REASON = "missing_birth_date";

function blank(value: string | null): boolean {
  return value === null || value.trim() === "";
}

export function dataQualityItems(
  employees: EmployeeGapRow[],
  users: UserGapRow[],
): DataQualityItem[] {
  const items: DataQualityItem[] = [];
  for (const employee of employees) {
    if (blank(employee.birthDate)) {
      items.push({
        id: `employee:${employee.id}:birth_date`,
        entityType: "employee",
        entityId: employee.id,
        field: "birth_date",
        reason: BIRTH_REASON,
        impact: "無法依年齡計算健檢頻率。",
        nextAction: { tab: "employees" },
        dueDate: null,
      });
    }
    if (blank(employee.department)) {
      items.push({
        id: `employee:${employee.id}:department`,
        entityType: "employee",
        entityId: employee.id,
        field: "department",
        reason: "blank_department",
        impact: "無法依部門篩選報表。",
        nextAction: { tab: "employees" },
        dueDate: null,
      });
    }
  }
  for (const user of users) {
    items.push({
      id: `user:${user.id}:employee_id`,
      entityType: "user",
      entityId: user.id,
      field: "employee_id",
      reason: "unlinked_account",
      impact: "帳號未連結員工，員工端 API 會 403。",
      nextAction: { tab: "settings" },
      dueDate: null,
    });
  }
  return items;
}

export async function listDataQuality(context: ApiContext): Promise<Response> {
  const [employees, users] = await Promise.all([
    context.env.DB.prepare(`
      SELECT id, birth_date AS birthDate, department
      FROM employees
      WHERE birth_date IS NULL OR TRIM(birth_date) = '' OR TRIM(department) = ''
      ORDER BY id
    `).all<EmployeeGapRow>(),
    context.env.DB.prepare(`
      SELECT id
      FROM users
      WHERE employee_id IS NULL AND archived_at IS NULL
      ORDER BY id
    `).all<UserGapRow>(),
  ]);
  const items = dataQualityItems(employees.results, users.results);
  return json({
    counts: {
      total: items.length,
      birthDate: items.filter((item) => item.field === "birth_date").length,
      department: items.filter((item) => item.field === "department").length,
      unlinkedAccount: items.filter((item) => item.field === "employee_id").length,
    },
    items,
  });
}
