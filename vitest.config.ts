import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
      return {
        main: "./test/entry.ts",
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // 測試環境一律關閉人機驗證。
            //
            // 測試會連同 .dev.vars 一起載入，因此只要開發者在本機設定了
            // Turnstile 金鑰，所有會登入的測試都會被擋在 403——那是十幾個測試
            // 檔同時垮掉、而且與程式碼改動毫無關係的失敗，極難聯想到成因。
            // 這裡以空字串覆蓋，isTurnstileEnabled() 讀到就視為未啟用。
            //
            // 需要驗證 Turnstile 行為的測試請自行在測試內覆寫 env
            // （見 test/turnstile.test.ts 的 withTurnstileEnabled）。
            TURNSTILE_SITE_KEY: "",
            TURNSTILE_SECRET_KEY: "",
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
