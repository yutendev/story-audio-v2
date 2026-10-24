// Prisma client factory (T2.4) — 1 instance cho cả process; test chỉ override DATABASE_URL.
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client";

let dbInstance: PrismaClient | undefined;

export function getDb(connectionOverride?: string): PrismaClient {
  if (dbInstance && !connectionOverride) return dbInstance;
  const connectionString =
    connectionOverride ?? process.env.DATABASE_URL ?? "";
  if (!connectionString) throw new Error("DATABASE_URL trống — copy .env.example → .env");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  if (!connectionOverride) dbInstance = prisma;
  return prisma;
}

// Lỗi domain của repo layer — caller chỉ phân loại bằng các class này, không nhìn P-code.
export class RepositoryError extends Error {}
export class NotFoundError extends RepositoryError {}
export class ConflictError extends RepositoryError {}
export class ValidationError extends RepositoryError {}
