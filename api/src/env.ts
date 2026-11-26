import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGIN: z.string().min(1).default("http://localhost:5173"),
  /** Zone that daily averages, annual years and peak hours are reported in. */
  ANALYTICS_TIMEZONE: z.string().min(1).default("Asia/Manila"),
  /** Minutes between analytics refresh cycles (rollups, daily summaries, events, retention). */
  ANALYTICS_INTERVAL_MINUTES: z.coerce.number().positive().default(5),
  /** Raw readings that were "Good" are deleted after this many days. */
  RETENTION_GOOD_DAYS: z.coerce.number().int().min(1).default(30),
  RETENTION_AUTO_DELETE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Required as X-Admin-Key for manual deletion. Manual deletion is disabled when unset. */
  ADMIN_API_KEY: z.string().min(12).optional().or(z.literal("").transform(() => undefined))
});

export const env = envSchema.parse(process.env);

