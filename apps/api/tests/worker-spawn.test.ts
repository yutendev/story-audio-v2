// T3.4 tests — spawn an toàn: success / non-zero exit / malformed JSON line / timeout / ENOENT.
// Không dùng python thật: dùng process.execPath (node.exe) như "worker" để test offline.
import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SpawnFailedError, buildWorkerArgv, runWorkerProcess } from "../src/worker-spawn";

const NODE = process.execPath; // node.exe thật — không shell, argv thật

describe("runWorkerProcess — protocol stdout", () => {
  it("success: JSONL events được thu, exit 0", async () => {
    const script = [
      "console.log(JSON.stringify({protocol:'1',type:'stage_started',seq:0,job_id:'j',stage:'extract'}));",
      "console.log(JSON.stringify({protocol:'1',type:'final',seq:1,job_id:'j',status:'success',summary:'ok'}));",
    ].join("\n");
    const res = await runWorkerProcess({ argv: [NODE, "-e", script], timeoutMs: 20000 });
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.events).toHaveLength(2);
    expect(res.events[0].type).toBe("stage_started");
    expect(res.events[1].type).toBe("final");
    expect(res.malformed).toHaveLength(0);
  });

  it("non-zero exit: exit code giữ nguyên", async () => {
    const res = await runWorkerProcess({
      argv: [NODE, "-e", "process.exit(10)"],
      timeoutMs: 20000,
    });
    expect(res.exitCode).toBe(10);
  });

  it("malformed JSON line: báo malformed, các line hợp lệ vẫn parse", async () => {
    const res = await runWorkerProcess({
      argv: [
        NODE,
        "-e",
        "console.log('garbage dòng hỏng');console.log(JSON.stringify({type:'x'}))",
      ],
      timeoutMs: 20000,
    });
    expect(res.malformed).toHaveLength(1);
    expect(res.malformed[0].line).toContain("garbage");
    expect(res.events).toEqual([{ type: "x" }]);
  });

  it("timeout: kill sau timeoutMs → timedOut=true, không treo", async () => {
    const res = await runWorkerProcess({
      argv: [NODE, "-e", "setInterval(()=>{},1000)"],
      timeoutMs: 600,
    });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBeNull();
  });

  it("early process error (ENOENT): reject SpawnFailedError", async () => {
    await expect(
      runWorkerProcess({ argv: ["Z:\\khong-ton-tai\\khong-co.exe", "--x"], timeoutMs: 5000 }),
    ).rejects.toBeInstanceOf(SpawnFailedError);
  });

  it("argv builder: không ghép chuỗi — mỗi token một phần tử", () => {
    const argv = buildWorkerArgv({
      pythonPath: "C:/py/python.exe",
      configPath: join("C:", "work", "job.json"),
      jobId: "job-42",
      action: "extract",
      workdir: "C:/work/j42",
    });
    expect(argv).toEqual([
      "C:/py/python.exe",
      "-m",
      "story_audio",
      "run",
      "--config",
      expect.stringContaining("job.json"),
      "--job-id",
      "job-42",
      "--action",
      "extract",
      "--workdir",
      "C:/work/j42",
    ]);
  });

  it("config file: temp file được đọc bởi worker thật (viết + đọc ngược)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t34-"));
    const configPath = join(dir, "payload.json");
    await writeFile(configPath, JSON.stringify({ hello: "world" }), "utf-8");
    const res = await runWorkerProcess({
      argv: [NODE, "-e", `const s=require("fs").readFileSync(process.argv[1],"utf8");console.log(s)` , configPath],
      timeoutMs: 20000,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
  });
});
