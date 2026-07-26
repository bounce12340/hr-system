// 重置本機 D1 並重跑所有 migration，取回乾淨的種子資料。
//
// 存在理由：登入流程強制首次改密碼（規格 §三），因此每次有人在本機實測、
// 改了 demo 帳號密碼卻沒留存，下一次就登不進去，也沒有找回密碼的途徑。
// 與其靠紀律記住改成什麼，不如讓復原變成一道指令。
//
// 只動 .wrangler/state/v3/d1（本機模擬狀態），不會碰到任何遠端資料庫。

import { existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localD1 = join(projectRoot, ".wrangler", "state", "v3", "d1");

if (existsSync(localD1)) {
  try {
    rmSync(localD1, { recursive: true, force: true });
    console.log("已移除本機 D1 狀態：.wrangler/state/v3/d1");
  } catch (error) {
    // 最常見原因是 dev server 仍在執行、檔案被鎖住。
    console.error("無法移除本機 D1 狀態：", error instanceof Error ? error.message : error);
    console.error("請先關閉正在執行的 wrangler dev／pages dev（或殘留的 workerd 程序）後再試一次。");
    process.exit(1);
  }
} else {
  console.log("本機無 D1 狀態，直接套用 migration。");
}

// Windows 上 Node 自 CVE-2024-27980 修補後，不帶 shell 就無法 spawn .cmd／.bat
// （會丟 EINVAL），因此一律走 shell。
const result = spawnSync("npx wrangler d1 migrations apply DB --local", {
  cwd: projectRoot,
  stdio: "inherit",
  shell: true,
});

if (result.error) {
  console.error("無法執行 wrangler：", result.error.message);
  process.exit(1);
}
if (result.status !== 0) {
  console.error("migration 套用失敗，請檢查上方輸出。");
  process.exit(result.status ?? 1);
}

console.log("");
console.log("本機資料庫已重置完成。");
console.log("Admin：admin@demo.local／Demo1234!（首次登入會強制改密碼）");
console.log("本機實測請一律改為：AcceptDemo2026!");
