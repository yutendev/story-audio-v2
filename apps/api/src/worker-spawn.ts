// Worker spawn (T3.4) — SAFE: child_process.spawn với mảng argv cố định, shell:false.
// Không bao giờ ghép chuỗi lệnh (no shell interpolation) — URL/user input chỉ vào argv hoặc file.
import { spawn } from "node:child_process";

export interface WorkerRunResult {
  /** null khi bị timeout-kill (Windows: terminate không trả exit code đáng tin). */
  exitCode: number | null;
  timedOut: boolean;
  /** các dòng stdout parse được JSON — object thô; protocol validation thật ở T3.5. */
  events: Record<string, unknown>[];
  malformed: { line: string; error: string }[];
  stderr: string;
}

export interface RunWorkerOptions {
  /** mảng argv hoàn chỉnh: [python, "-m", "story_audio", "run", "--config", path, ...] . */
  argv: string[];
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** Abort của runner/cancel — đứt child NGAY (không đợi stage xong) giữ nguyên exitCode null. */
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  onEvent?: (event: Record<string, unknown>) => Promise<void> | void;
}

export class SpawnFailedError extends Error {}

export async function runWorkerProcess(opts: RunWorkerOptions): Promise<WorkerRunResult> {
  if (!Array.isArray(opts.argv) || opts.argv.length === 0) {
    throw new SpawnFailedError("argv không hợp lệ");
  }
  return new Promise((resolve, reject) => {
    // shell: false — argv[i] giữ nguyên như đối số; không tồn tại chuỗi ghép lệnh
    const child = spawn(opts.argv[0], opts.argv.slice(1), {
      shell: false,
      env: opts.env,
      windowsHide: true,
    });

    const result: WorkerRunResult = { exitCode: null, timedOut: false, events: [], malformed: [], stderr: "" };
    let stdoutBuf = "";
    let settled = false;

    const timer = setTimeout(() => {
      result.timedOut = true;
      child.kill();
    }, opts.timeoutMs);
    const onAbort = (): void => {
      result.timedOut = true; // cùng nghĩa: bị giết, KHÔNG trả exitCode đáng tin
      child.kill();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      settled = true;
      clearTimeout(timer);
      reject(new SpawnFailedError(`spawn lỗi sớm: ${err.message}`));
    });

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      let idx: number;
      while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, idx).replace(/\r$/, "");
        stdoutBuf = stdoutBuf.slice(idx + 1);
        opts.onStdoutLine?.(line);
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const evObj = parsed as Record<string, unknown>;
            result.events.push(evObj);
            opts.onEvent?.(evObj);
          } else {
            result.malformed.push({ line, error: "JSON đầu vào là object" });
          }
        } catch (e) {
          result.malformed.push({ line, error: String((e as Error).message) });
        }
      }
    });

    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      result.stderr += chunk;
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return; // error đã reject
      result.exitCode = result.timedOut ? null : code;
      resolve(result);
    });
  });
}

/** Cố định argv của worker CLI (T1.2 contract) — không ghép chuỗi. */
export function buildWorkerArgv(input: {
  pythonPath: string;
  configPath: string;
  jobId: string;
  action: string;
  workdir: string;
}): string[] {
  return [
    input.pythonPath,
    "-m",
    "story_audio",
    "run",
    "--config",
    input.configPath,
    "--job-id",
    input.jobId,
    "--action",
    input.action,
    "--workdir",
    input.workdir,
  ];
}
