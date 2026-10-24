// One-off: dọn job test (`https://example.invalid/*`) khỏi DB dev — KHÔNG đụng job thật.
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const { PrismaClient } = await import("../src/generated/client");
const { PrismaPg } = await import("@prisma/adapter-pg");
const p = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
});
const r = await p.job.deleteMany({
  where: { sourceUrl: { startsWith: "https://example.invalid/" } },
});
console.log("deleted-jobs", r.count);
await p.$disconnect();
