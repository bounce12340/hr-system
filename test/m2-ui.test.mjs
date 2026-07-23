import { exports } from "cloudflare:workers";
import { h } from "preact";
import render from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { CertificationReminderList } from "../src/client/components/CertificationReminderList";

async function call(path, init) {
  const response = await exports.default.fetch(`https://example.com${path}`, init);
  return { response, body: await response.json() };
}

async function loginAndChange(email, newPassword) {
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

describe("M2 證照提醒可見渲染", () => {
  it("seed 的 25 天到期證照會渲染在 admin 儀表板提醒區", async () => {
    const cookie = await loginAndChange("admin@demo.local", "AdminUiChanged1234!");
    const dashboard = await call("/api/admin/dashboard", { headers: { Cookie: cookie } });
    const html = render(h(CertificationReminderList, {
      reminders: dashboard.body.data?.certificationReminders ?? [],
      showEmployee: true,
      emptyText: "目前沒有到期提醒。",
    }));
    expect(html).toContain('data-certification-id="ec-01"');
    expect(html).toContain("林家豪");
    expect(html).toContain("GDP 藥品優良運銷規範");
    expect(html).toMatch(/2[45] 天後到期/);
  });

  it("同一筆證照會渲染在 emp-002 個人首頁提醒區且不洩漏他人提醒", async () => {
    const cookie = await loginAndChange(
      "chiahao.lin@demo.local",
      "EmployeeUiChanged1234!",
    );
    const home = await call("/api/employee/home", { headers: { Cookie: cookie } });
    const reminders = home.body.data?.certificationReminders ?? [];
    const html = render(h(CertificationReminderList, {
      reminders,
      showEmployee: false,
      emptyText: "目前沒有即將到期的證照。",
    }));
    expect(reminders.every((reminder) => reminder.employeeId === "emp-002")).toBe(true);
    expect(html).toContain('data-certification-id="ec-01"');
    expect(html).toContain("GDP 藥品優良運銷規範");
    expect(html).toMatch(/2[45] 天後到期/);
  });
});
