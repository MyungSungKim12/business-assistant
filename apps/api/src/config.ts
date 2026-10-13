import { z } from 'zod';

const ServerConfigSchema = z.object({
  APP_SUPABASE_URL: z.url(),
  APP_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  APP_SUPABASE_SERVICE_KEY: z.string().min(1).optional(),
  APP_FILE_BUCKET: z.string().min(1).default('business-files'),
  APP_API_PORT: z.coerce.number().int().positive().default(8000),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export function parseServerConfig(environment: Record<string, string | undefined>): ServerConfig {
  const result = ServerConfigSchema.safeParse(environment);
  if (result.success) return result.data;

  const missing = result.error.issues.map((issue) => issue.path.join('.')).join(', ');
  throw new Error(`서버 환경 변수를 확인해 주세요: ${missing}`);
}
