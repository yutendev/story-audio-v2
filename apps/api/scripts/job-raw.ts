// Raw dump 1 job: mọi field + configSnapshot đầy đủ + đếm bookPackage.
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const { PrismaClient } = await import("../src/generated/client");
const { PrismaPg } = await import("@prisma/adapter-pg");
const p = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
});

for (const id of process.argv.slice(2)) {
  const j = await p.job.findUnique({ where: { id } });
  if (!j) { console.log(JSON.stringify({ id, missing: true })); continue; }
  const pkgs = await p.bookPackage.findMany({ where: { jobId: id } });
  console.log(JSON.stringify({ ...j, pkgs: pkgs.map((x) => ({ sequence: x.sequence, state: x.state })) }, null, 1));
}
await p.$disconnect();
