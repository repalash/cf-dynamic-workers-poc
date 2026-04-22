import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config"
import path from "node:path"

export default defineWorkersConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "./src/shared"),
    },
  },
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.test.jsonc" },
        miniflare: {
          compatibilityDate: "2026-01-28",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: { TEENY_PRIMARY_DB: "cf-dynamic-workers-poc-db" },
          workerLoaders: { LOADER: {} },
          bindings: {
            MIGRATE_UI_USER: "admin",
            MIGRATE_UI_PASSWORD: "devpassword",
            DEBUG_ERRORS: "1",
          },
        },
      },
    },
  },
})
