// R2 adapter (T4.1) — S3-compatible API, private bucket. Testable qua DI client.
// KHÔNG log credentials/là keys: mọi error chỉ bubblé message ngành nhiều.
import { createHash } from "node:crypto";

import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, type S3ClientConfig } from "@aws-sdk/client-s3";

import type { R2Config } from "./r2-config";
import { r2Endpoint } from "./r2-config";

/** phần nhỏ đi tốt — PUT ~20MB một mạch bị TLS đứt giữa dòng (ssl3 alert bad record mac). */
const PUT_MULTIPART_THRESHOLD = 8 * 1024 * 1024;
const PART_SIZE = 5 * 1024 * 1024; // min part của R2: 5MiB (trừ phần cuối)
const PART_ATTEMPTS = 2;

/** Abstraction — code nghiệp vụ chỉ dùng interface; tests mock interface này. */
export interface ObjectStoreAdapter {
  putObject(input: { key: string; body: Buffer; contentType?: string }): Promise<{ etag?: string }>;
  getObject(key: string): Promise<{ data: Buffer; contentType?: string } | null>;
  headObject(key: string): Promise<{ size: number; etag?: string } | null>;
  deleteObject(key: string): Promise<void>;
}

interface SendLike {
  send(command: unknown): Promise<unknown>;
}

export function createR2Client(config: R2Config): S3Client {
  const clientConfig: S3ClientConfig = {
    region: "auto",
    endpoint: r2Endpoint(config.accountId.trim()),
    credentials: {
      accessKeyId: config.accessKeyId.trim(),
      secretAccessKey: config.secretAccessKey.trim(),
    },
    forcePathStyle: true,
  };
  return new S3Client(clientConfig);
}

export function createR2S3Adapter(config: R2Config, client?: SendLike): ObjectStoreAdapter {
  const s3 = client ?? createR2Client(config);
  const bucket = config.bucket.trim();

  return {
    async putObject({ key, body, contentType }) {
      if (body.length <= PUT_MULTIPART_THRESHOLD) {
        const r = (await s3.send(
          new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
        )) as { ETag?: string };
        return { etag: r.ETag };
      }
      const created = (await s3.send(
        new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
      )) as { UploadId?: string };
      const uploadId = created.UploadId;
      try {
        const parts: { PartNumber: number; ETag: string }[] = [];
        for (let i = 0; i * PART_SIZE < body.length; i++) {
          const sub = body.subarray(i * PART_SIZE, Math.min((i + 1) * PART_SIZE, body.length));
          let etag: string | undefined;
          for (let a = 0; a < PART_ATTEMPTS; a++) {
            try {
              const rr = (await s3.send(
                new UploadPartCommand({ Bucket: bucket, Key: key, PartNumber: i + 1, UploadId: uploadId, Body: sub }),
              )) as { ETag?: string };
              // composite etag không cover nội dung part — verify md5 từng phần NGAY ĐÂY
              const et = (rr.ETag ?? "").replace(/"/g, "").toLowerCase();
              if (et && et !== createHash("md5").update(sub).digest("hex")) {
                throw new Error(`part ${i + 1}: etag ≠ md5 phần`);
              }
              etag = rr.ETag;
              break;
            } catch (e) {
              if (a === PART_ATTEMPTS - 1) throw e;
            }
          }
          parts.push({ PartNumber: i + 1, ETag: etag as string });
        }
        const done = (await s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket, Key: key, UploadId: uploadId,
            MultipartUpload: { Parts: parts },
          }),
        )) as { ETag?: string };
        return { etag: done.ETag };
      } catch (e) {
        try { // dọn session mồ côi — R2 tự hủy incomplete 7 ngày nếu abort hụt
          await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
        } catch { /* abort lỗi không che lỗi gốc */ }
        throw e;
      }
    },

    async getObject(key) {
      let r: Awaited<ReturnType<S3Client["send"]>>;
      try {
        r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      } catch (e) {
        if ((e as { name?: string }).name === "NoSuchKey" || (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
          return null;
        }
        throw e;
      }
      const data = await (r as { Body?: { transformToByteArray: () => Promise<Uint8Array> } }).Body?.transformToByteArray();
      if (!data) return null;
      return { data: Buffer.from(data), contentType: (r as { ContentType?: string }).ContentType };
    },

    async headObject(key) {
      let r: unknown;
      try {
        r = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      } catch (e) {
        const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404) return null;
        throw e;
      }
      const h = r as { ContentLength?: number; ETag?: string };
      return { size: h.ContentLength ?? 0, etag: h.ETag };
    },

    async deleteObject(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
