import { z } from 'zod/v4';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres URL'),
  CORS_ORIGIN: z.string().min(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type AppConfig = z.infer<typeof configSchema>;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function present(env: NodeJS.ProcessEnv): Record<string, string> {
  const source: Record<string, string> = {};
  for (const key of [
    'NODE_ENV',
    'HOST',
    'PORT',
    'DATABASE_URL',
    'CORS_ORIGIN',
    'LOG_LEVEL',
  ] as const) {
    const value = env[key];
    if (value !== undefined && value !== '') {
      source[key] = value;
    }
  }
  return source;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = configSchema.safeParse(present(env));
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigurationError(`Invalid configuration:\n${details}`);
  }
  return parsed.data;
}
