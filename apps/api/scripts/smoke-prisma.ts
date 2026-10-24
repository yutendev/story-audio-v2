// Smoke: Prisma Client v7 + driver adapter pg — chạy: npm run smoke (tsx + DATABASE_URL từ root .env)
import { fileURLToPath } from "node:url";

import { config } from "dotenv";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/client";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL as string });
const prisma = new PrismaClient({ adapter });

try {
  const rows = await prisma.$queryRaw<{ db: string; version: string }>`
    SELECT current_database() AS db, current_setting('server_version') AS version`;
  console.log("SMOKE OK:", rows.map((r) => `${r.db} / PG ${r.version}`));
} finally {
  await prisma.$disconnect();
}
