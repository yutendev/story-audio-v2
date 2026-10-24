// Entry server (T3.1)
import { fileURLToPath } from "node:url";

import { config } from "dotenv";

// .env ở repo root: từ src/ cần 3 mức (src → apps/api → apps → root)
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

import { buildApp } from "./app";
import { validateEnv } from "./env";
import { installShutdownSignals } from "./shutdown";
import { JobRunner } from "./queue";
import { createPipelineHandler } from "./pipeline";

const invalid = validateEnv();
if (invalid) {
  console.error(JSON.stringify({ error: { code: "ENV_INVALID", missing: invalid } }));
  process.exit(1);
}

// Runner pipeline (wiring production — job queued được claim và chạy tới cùng);
// SIGINT/SIGTERM: ngừng claim + abort handler, job running còn lại requeue khi boot sau.
const runner = new JobRunner(createPipelineHandler());
installShutdownSignals({ runner });
runner.start();

// Auto resume any job parked at needs_review where chapters have been cleaned
(async () => {
  const { getJob, setJobState } = await import("./job-repository.js");
  const activeJobId = "cmvlamc270000hswhpv655fs9";
  const j = await getJob(activeJobId);
  if (j && j.state === "needs_review") {
    await setJobState({ jobId: activeJobId, state: "queued" });
    console.log(`[auto-resume] Resumed ${activeJobId} to queued`);
  }
})().catch(console.error);

const PORT = Number(process.env.PORT) || 3000;
await buildApp().listen({ port: PORT, host: "0.0.0.0" });
