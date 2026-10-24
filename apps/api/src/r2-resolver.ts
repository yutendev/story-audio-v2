// R2 resolver (T4.4) — 1 điểm chỉ cung cấp store + presigner; test nhét fake qua override.
// CHÍNH SÁCH: bucket riêng tư — mọi download cho packager/UI đi qua 2 surface này;
// presigner KHÔNG bao giờ lọt credentials vào URL cho browser nhận (signed GET ngắn hạn).
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { readR2Config, validateR2Config } from "./r2-config";
import { createR2Client, createR2S3Adapter, type ObjectStoreAdapter } from "./r2-adapter";
import { RepositoryError } from "./db";

export interface PresignerLike {
  presign(key: string, expiresIn: number): Promise<string>;
}

export class R2UnavailableError extends RepositoryError {}

export interface R2Instances {
  store: ObjectStoreAdapter;
  presigner: PresignerLike;
}

let injected: R2Instances | null = null; // test override
let cached: R2Instances | null = null;

/** Test-only: thay toàn bộ R2 instances (store fake + presigner fake). */
export function overrideR2ForTests(instances: R2Instances | null): void {
  injected = instances;
  cached = null;
}

export function resolveR2(): R2Instances {
  if (injected) return injected;
  if (cached) return cached;
  const config = readR2Config();
  const problems = validateR2Config(config);
  if (problems.length) {
    // chỉ report TÊN env, không in giá trị
    throw new R2UnavailableError(
      `R2 chưa cấu hình đúng: ${problems.map((p) => `${p.field} (${p.reason})`).join("; ")}`,
    );
  }
  cached = { store: createR2S3Adapter(config), presigner: createR2Presigner(config) };
  return cached;
}

/** Presigner thật: signed GET bằng SigV4 — không chứa credentials, hết hạn theo expires. */
export function createR2Presigner(config: ReturnType<typeof readR2Config>): PresignerLike {
  const client = createR2Client(config);
  const bucket = config.bucket.trim();
  return {
    async presign(key: string, expiresIn: number): Promise<string> {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn,
      });
    },
  };
}
