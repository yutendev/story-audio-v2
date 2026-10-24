// Theo dõi job thật khi runner chạy: `npx tsx scripts/job-status.ts [jobId...]`
// Không args → in mọi job mới nhất (10). In state/chapters/events đuôi.
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const { PrismaClient } = await import("../src/generated/client");
const { PrismaPg } = await import("@prisma/adapter-pg");
const p = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
});

const ids = process.argv.slice(2);
const jobs = ids.length
  ? await p.job.findMany({ where: { id: { in: ids } }, orderBy: { createdAt: "asc" } })
  : await p.job.findMany({ orderBy: { createdAt: "desc" }, take: 10 });

for (const j of jobs) {
  const chapters = await p.chapter.count({ where: { jobId: j.id } });
  const stages = await p.chapter.groupBy({
    by: ["stageState"],
    where: { jobId: j.id },
    _count: { stageState: true },
  });
  const events = await p.jobEvent.findMany({
    where: { jobId: j.id },
    orderBy: [{ seq: "desc" }],
    take: 6,
  });
  console.log(
    JSON.stringify({
      job: j.id,
      url: j.sourceUrl.slice(0, 60),
      state: j.state,
      claimedAt: j.claimedAt,
      notBefore: j.notBefore,
      lastError: j.lastError,
      chapters,
      stages: stages.map((s) => `${s.stageState}:${s._count.stageState}`).join(" "),
      lastEvents: events.map((e) => `#${e.seq} ${e.eventType}${e.message ? ` | ${e.message.slice(0, 90)}` : ""}`),
    }),
  );
}
await p.$disconnect();
