// Env validation (T3.1) — fail-fast trước khi mở port; trả danh sách thiếu/sai.
export function validateEnv(): { field: string; reason: string }[] | null {
  const problems: { field: string; reason: string }[] = [];
  const url = process.env.DATABASE_URL;
  if (!url || !url.trim()) {
    problems.push({ field: "DATABASE_URL", reason: "thiếu" });
  } else if (!/^postgres(ql)?:\/\//.test(url.trim())) {
    problems.push({ field: "DATABASE_URL", reason: "phải là postgres:// URL" });
  }
  return problems.length ? problems : null;
}
