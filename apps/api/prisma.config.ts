import { fileURLToPath } from "node:url";

import { defineConfig, env } from "prisma/config";
import { config as loadDotenv } from "dotenv";

// Single source of truth: .env ở GỐC repo (apps/api/prisma.config.ts → ../../.env)
loadDotenv({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
