// One-off: dump TOÀN BỘ JobEvent của job (seq asc, kèm thời điểm tạo) — soi con dấu attempt.
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const { PrismaClient } = await import("../src/generated/client");
const { PrismaPg } = await import("@prisma/adapter-pg");
const p = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
});

const jobId = process.argv[2];
const events = await p.jobEvent.findMany({
  where: { jobId },
  orderBy: { seq: "asc" },
  select: { seq: true, eventType: true, message: true, createdAt: true },
});
for (const e of events) {
  console.log(`#${e.seq} ${e.createdAt.toISOString().slice(11, 23)} ${e.eventType} ${e.message?.slice(0, 80) ?? ""}`);
}
await p.$disconnect();
