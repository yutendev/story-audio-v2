// T4.1 tests — config offline validation + adapter qua fake send (KHÔNG chạm R2 thật).
// Quy tắc: không bao giờ in secret — thử assert điều này.
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

import { r2Endpoint, readR2Config, validateR2Config, type R2Config } from "../src/r2-config";
import { createR2S3Adapter } from "../src/r2-adapter";

const OK_CONFIG: R2Config = {
  accountId: "a".repeat(32),
  accessKeyId: "AKIA-test",
  secretAccessKey: "SUPERSECRET-should-not-leak",
  bucket: "story-audio-dev",
};

describe("validateR2Config — offline, không tiếp xúc mạng", () => {
  it("config đầy đủ chuẩn → []", () => {
    expect(validateR2Config(OK_CONFIG)).toEqual([]);
  });

  it("thiếu field → report đúng LDS tên env (không in giá trị)", () => {
    const problems = validateR2Config({ accountId: "", accessKeyId: "", secretAccessKey: "", bucket: "" });
    expect(problems.map((p) => p.field).sort()).toEqual([
      "R2_ACCESS_KEY_ID",
      "R2_ACCOUNT_ID",
      "R2_BUCKET",
      "R2_SECRET_ACCESS_KEY",
    ]);
    const text = JSON.stringify(problems);
    expect(text).not.toContain("SUPERSECRET");
  });

  it("accountId không phải 32 hex → có ý nghĩa", () => {
    const problems = validateR2Config({ ...OK_CONFIG, accountId: "zzz" });
    expect(problems.some((p) => p.field === "R2_ACCOUNT_ID")).toBe(true);
  });

  it("readR2Config đọc từ process.env", () => {
    const saved = process.env.R2_ACCOUNT_ID;
    process.env.R2_ACCOUNT_ID = "a".repeat(32);
    try {
      const c = readR2Config();
      expect(c.accountId).toBe("a".repeat(32));
    } finally {
      if (saved === undefined) delete process.env.R2_ACCOUNT_ID;
      else process.env.R2_ACCOUNT_ID = saved;
    }
  });

  it("r2Endpoint theo account id", () => {
    expect(r2Endpoint("a".repeat(32))).toBe(`https://${"a".repeat(32)}.r2.cloudflarestorage.com`);
  });
});

describe("createR2S3Adapter — DI fake send (mock, không mạng)", () => {
  function fakeSend(responses: Record<string, unknown>) {
    const sent: { cmdType: string; input: unknown }[] = [];
    return {
      sent,
      send: async (cmd: unknown) => {
        const type = (cmd as { constructor?: { name: string } }).constructor?.name ?? "?";
        sent.push({ cmdType: type, input: (cmd as { input?: unknown }).input });
        let response = responses[type];
        // mô phỏng SDK throw: Error instance hoặc marker __fail (error có thể là object $metadata)
        if (response instanceof Error || (response as { __fail?: boolean }).__fail) {
          throw response instanceof Error ? response : (response as { error: unknown }).error;
        }
        return response;
      },
    };
  }

  it("putObject → PutObjectCommand với Bucket/Key/Body", async () => {
    const fake = fakeSend({ PutObjectCommand: { ETag: '"etag-1"' } });
    const adapter = createR2S3Adapter(OK_CONFIG, fake);
    const r = await adapter.putObject({ key: "jobs/j1/desc.txt", body: Buffer.from("hi"), contentType: "text/plain" });
    expect(r.etag).toBe('"etag-1"');
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0].cmdType).toBe("PutObjectCommand");
    expect((fake.sent[0].input as Record<string, unknown>).Bucket).toBe("story-audio-dev");
    expect((fake.sent[0].input as Record<string, unknown>).Key).toBe("jobs/j1/desc.txt");
  });

  it("getObject auto → data buffer + null ở NoSuchKey", async () => {
    const notFound = new Error("NoSuchKey");
    (notFound as { name?: string }).name = "NoSuchKey";
    const fake = fakeSend({
      GetObjectCommand: { Body: { transformToByteArray: async () => new Uint8Array([1, 2]) }, ContentType: "text/plain" },
    });
    const adapter404 = createR2S3Adapter(OK_CONFIG, fakeSend({ GetObjectCommand: { __fail: true, error: notFound } }));
    expect(await adapter404.getObject("missing")).toBeNull();
    const adapter = createR2S3Adapter(OK_CONFIG, fake);
    const got = await adapter.getObject("jobs/j1/d.txt");
    expect(got?.data.toString()).toBe("\x01\x02");
    expect(got?.contentType).toBe("text/plain");
  });

  it("headObject trả size/etag; 404 → null", async () => {
    const notFound404 = { $metadata: { httpStatusCode: 404 } };
    const adapterOk = createR2S3Adapter(
      OK_CONFIG,
      fakeSend({ HeadObjectCommand: { ContentLength: 5, ETag: '"x"' } }),
    );
    expect(await adapterOk.headObject("k")).toEqual({ size: 5, etag: '"x"' });
    const adapterMissing = createR2S3Adapter(
      OK_CONFIG,
      fakeSend({ HeadObjectCommand: { __fail: true, error: notFound404 } }),
    );
    expect(await adapterMissing.headObject("k")).toBeNull();
  });

  it("deleteObject → DeleteObjectCommand", async () => {
    const fake = fakeSend({ DeleteObjectCommand: {} });
    await createR2S3Adapter(OK_CONFIG, fake).deleteObject("jobs/j1/x");
    expect(fake.sent[0].cmdType).toBe("DeleteObjectCommand");
  });

  it("KHÔNG log secret: khi put lỗi, message/adapter không chứa secret", async () => {
    const err = new Error("Forbidden");
    const failing = fakeSend({ PutObjectCommand: err });
    const adapter = createR2S3Adapter(OK_CONFIG, failing);
    const logSpy = vi.spyOn(console, "log");
    const errSpy = vi.spyOn(console, "error");
    try {
      await expect(adapter.putObject({ key: "k", body: Buffer.from("x") })).rejects.toThrow("Forbidden");
      const allLogs = [logSpy.mock.calls, errSpy.mock.calls].flat().map(String).join("\n");
      expect(allLogs).not.toContain("SUPERSECRET");
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("putObject ≤ ngưỡng vẫn là 1 PutObject", async () => {
    const fake = fakeSend({ PutObjectCommand: { ETag: '"e"' } });
    await createR2S3Adapter(OK_CONFIG, fake).putObject({
      key: "jobs/j1/audio.mp3",
      body: Buffer.alloc(8 * 1024 * 1024, 7), // ĐÚNG ngưỡng → đi đường cũ
    });
    expect(fake.sent.map((s) => s.cmdType)).toEqual(["PutObjectCommand"]);
  });

  it("putObject lớn → multipart: create + part theo 5MB + complete", async () => {
    const log: { cmdType: string; input: any }[] = [];
    const fake = {
      send: async (cmd: unknown) => {
        const type = (cmd as { constructor?: { name: string } }).constructor?.name ?? "?";
        const input = (cmd as { input?: unknown }).input;
        log.push({ cmdType: type, input });
        if (type === "CreateMultipartUploadCommand") return { UploadId: "u1" };
        if (type === "UploadPartCommand") return { ETag: `"${createHash("md5").update((input as { Body: Buffer }).Body).digest("hex")}"` };
        if (type === "CompleteMultipartUploadCommand") return { ETag: '"whole"' };
        throw new Error(`không vọng: ${type}`);
      },
    };
    // 12MB → 3 phần (5+5+2)
    const r = await createR2S3Adapter(OK_CONFIG, fake as any).putObject({
      key: "jobs/j1/audio.mp3",
      body: Buffer.alloc(12 * 1024 * 1024, 7),
      contentType: "audio/mpeg",
    });
    expect(r.etag).toBe('"whole"');
    const types = log.map((l) => l.cmdType);
    expect(types[0]).toBe("CreateMultipartUploadCommand");
    expect(types.filter((t) => t === "UploadPartCommand")).toHaveLength(3);
    expect(types.at(-1)).toBe("CompleteMultipartUploadCommand");
    const create = log[0].input as { Key?: string; ContentType?: string };
    expect(create.Key).toBe("jobs/j1/audio.mp3");
    expect(create.ContentType).toBe("audio/mpeg");
    const nums = log.filter((l) => l.cmdType === "UploadPartCommand").map((l) => (l.input as { PartNumber: number }).PartNumber);
    expect(nums).toEqual([1, 2, 3]);
  });

  it("putObject lớn: part lỗi 1 lần → thử lại (SSL tạm thời) rồi complete", async () => {
    const log: string[] = [];
    let firstPart = true;
    const fake = {
      send: async (cmd: unknown) => {
        const type = (cmd as { constructor?: { name: string } }).constructor?.name ?? "?";
        const input = (cmd as { input?: unknown }).input;
        log.push(type);
        if (type === "CreateMultipartUploadCommand") return { UploadId: "u1" };
        if (type === "UploadPartCommand") {
          if (firstPart) { firstPart = false; throw new Error("ssl3 alert bad record mac"); }
          return { ETag: `"${createHash("md5").update((input as { Body: Buffer }).Body).digest("hex")}"` };
        }
        if (type === "CompleteMultipartUploadCommand") return { ETag: '"whole"' };
        throw new Error(`không vọng: ${type}`);
      },
    };
    const r = await createR2S3Adapter(OK_CONFIG, fake as any).putObject({
      key: "jobs/j1/audio.mp3",
      body: Buffer.alloc(10 * 1024 * 1024 + 1, 7), // 10MB+1 → 3 phần (5+5+1)
    });
    expect(r.etag).toBe('"whole"');
    expect(log.filter((t) => t === "UploadPartCommand")).toHaveLength(4); // 1 fail + ok, 2 ok cho phần 2,3
    expect(log.at(-1)).toBe("CompleteMultipartUploadCommand");
  });

  it("putObject lớn: part hết lượt → rethrow + Abort multipart", async () => {
    const log: string[] = [];
    const fake = {
      send: async (cmd: unknown) => {
        const type = (cmd as { constructor?: { name: string } }).constructor?.name ?? "?";
        log.push(type);
        if (type === "CreateMultipartUploadCommand") return { UploadId: "u1" };
        if (type === "UploadPartCommand") throw new Error("ssl3 alert bad record mac");
        if (type === "CompleteMultipartUploadCommand") return { ETag: '"whole"' };
        if (type === "AbortMultipartUploadCommand") return {};
        throw new Error(`không vọng: ${type}`);
      },
    };
    await expect(
      createR2S3Adapter(OK_CONFIG, fake as any).putObject({
        key: "jobs/j1/audio.mp3",
        body: Buffer.alloc(12 * 1024 * 1024, 7),
      }),
    ).rejects.toThrow("bad record mac");
    expect(log).toContain("AbortMultipartUploadCommand");
    expect(log.filter((t) => t === "CompleteMultipartUploadCommand")).toHaveLength(0);
  });
});
