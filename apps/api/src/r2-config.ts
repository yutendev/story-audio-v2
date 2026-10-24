// R2 config (T4.1) — endpoint/account/bucket/credentials từ env; validate KHÔNG mạng.
// Chống leak: mọi chỗ báo lỗi chỉ in TÊN trường, không ever in giá trị secret.
export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export const R2_ENV_FIELDS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"] as const;

export function readR2Config(): R2Config {
  return {
    accountId: process.env.R2_ACCOUNT_ID ?? "",
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
    bucket: process.env.R2_BUCKET ?? "",
  };
}

/** Offline validation: thiếu/sai → danh sách {field, reason} (chỉ TÊN env, không giá trị). */
export function validateR2Config(config: R2Config): { field: string; reason: string }[] {
  const problems: { field: string; reason: string }[] = [];
  const envNames: Record<keyof R2Config, string> = {
    accountId: "R2_ACCOUNT_ID",
    accessKeyId: "R2_ACCESS_KEY_ID",
    secretAccessKey: "R2_SECRET_ACCESS_KEY",
    bucket: "R2_BUCKET",
  };
  for (const field of ["accountId", "accessKeyId", "secretAccessKey", "bucket"] as const) {
    if (!config[field].trim()) problems.push({ field: envNames[field], reason: "thiếu" });
  }
  if (config.accountId && !/^[0-9a-f]{32}$/i.test(config.accountId.trim())) {
    problems.push({ field: "R2_ACCOUNT_ID", reason: "phải là 32 hex (Cloudflare account id)" });
  }
  if (config.secretAccessKey.length > 128) {
    problems.push({ field: "R2_SECRET_ACCESS_KEY", reason: "độ dài bất thường" });
  }
  return problems;
}

/** Endpoint chuẩn của R2 cho 1 account id — client dùng. */
export function r2Endpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}
