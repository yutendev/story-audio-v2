// One-off: reset về queued SẠCH cho job rerun sau khi sửa lỗi:
// - xóa Chapter + JobEvent của job (hợp đồng mới: chapter_no = vị trí, data cũ lệch)
// - xóa workdir của job (dirs cũ ghi theo số chương sách → rác cho stage sau)
// - trả job về queued, không còn claim/notBefore/lastError/timestamps
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import { config } from "dotenv";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const { PrismaClient } = await import("../src/generated/client");
const { PrismaPg } = await import("@prisma/adapter-pg");
const p = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
});

const ids = ["cmvkc8luq0000dswh2j871x5z", "cmvkcb2ln0001dswhdvu9bfcp", "cmvkga65i001ajgwh7n4cxu8x"];
const workRoot = process.env.STORY_AUDIO_WORK_ROOT ?? "";
if (!workRoot.trim()) throw new Error("STORY_AUDIO_WORK_ROOT chưa cấu hình");

for (const id of ids) {
  const chapters = await p.chapter.deleteMany({ where: { jobId: id } });
  const events = await p.jobEvent.deleteMany({ where: { jobId: id } });
  const job = await p.job.update({
    where: { id },
    data: { state: "queued", claimedAt: null, notBefore: null, lastError: null, startedAt: null, endedAt: null },
  });
  rmSync(`${workRoot}/jobs/${id}`, { recursive: true, force: true });
  console.log(JSON.stringify({ id, state: job.state, chapters: chapters.count, events: events.count, workdir: "wiped" }));
}

await p.$disconnect();
