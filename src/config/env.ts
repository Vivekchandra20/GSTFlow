import { z } from 'zod';

export class ConfigurationError extends Error {
  public readonly issues: Array<{ field: string; message: string }>;

  constructor(message: string, issues: Array<{ field: string; message: string }> = []) {
    super(message);
    this.name = 'ConfigurationError';
    this.issues = issues;
    Object.setPrototypeOf(this, ConfigurationError.prototype);
  }
}

const PostgresUrlSchema = z.string().refine(
  (val) => {
    try {
      const parsed = new URL(val);
      return parsed.protocol === 'postgresql:' || parsed.protocol === 'postgres:';
    } catch {
      return false;
    }
  },
  { message: 'DATABASE_URL must be a valid PostgreSQL connection URL (e.g. postgresql://user:pass@host:5432/db)' }
);

const RedisUrlSchema = z.string().refine(
  (val) => {
    try {
      const parsed = new URL(val);
      return parsed.protocol === 'redis:' || parsed.protocol === 'rediss:';
    } catch {
      return false;
    }
  },
  { message: 'REDIS_URL must be a valid Redis connection URL (e.g. redis://user:pass@host:6379)' }
);

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z
    .preprocess((val) => (val !== undefined ? Number(val) : 3000), z.number().int().min(1).max(65535))
    .default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  REDIS_HOST: z.string().optional().default('127.0.0.1'),
  REDIS_PORT: z
    .preprocess((val) => (val !== undefined ? Number(val) : 6379), z.number().int().min(1).max(65535))
    .default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z
    .preprocess((val) => (val !== undefined ? Number(val) : 0), z.number().int().min(0).max(15))
    .default(0),
  USE_MOCK_REDIS: z
    .preprocess((val) => {
      if (typeof val === 'boolean') return val;
      if (typeof val === 'string') return val.toLowerCase() === 'true' || val === '1';
      return false;
    }, z.boolean())
    .default(false),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  CORS_ORIGIN: z.string().default('*'),
  BODY_LIMIT: z
    .preprocess((val) => (val !== undefined ? Number(val) : 1048576), z.number().int().min(1024).max(10485760))
    .default(1048576), // 1MB default, max 10MB
  REQUEST_TIMEOUT_MS: z
    .preprocess((val) => (val !== undefined ? Number(val) : 30000), z.number().int().min(1000).max(120000))
    .default(30000),
  HEALTH_CHECK_TIMEOUT_MS: z
    .preprocess((val) => (val !== undefined ? Number(val) : 2000), z.number().int().min(200).max(10000))
    .default(2000),
  JWT_ACCESS_SECRET: z
    .string()
    .min(16)
    .default('gstflow-dev-access-jwt-secret-32chars!!'),
  JWT_ACCESS_TTL_SECONDS: z
    .preprocess((val) => (val !== undefined ? Number(val) : 900), z.number().int().min(60).max(86400))
    .default(900), // 15 minutes default
  JWT_ISSUER: z.string().min(1).default('gstflow'),
  JWT_AUDIENCE: z.string().min(1).default('gstflow-api'),
  REFRESH_TOKEN_TTL_SECONDS: z
    .preprocess((val) => (val !== undefined ? Number(val) : 604800), z.number().int().min(3600).max(2592000))
    .default(604800), // 7 days default
  ARGON2_MEMORY_COST: z
    .preprocess((val) => (val !== undefined ? Number(val) : 65536), z.number().int().min(1024))
    .default(65536), // 64 MB
  ARGON2_TIME_COST: z
    .preprocess((val) => (val !== undefined ? Number(val) : 3), z.number().int().min(1))
    .default(3),
  COOKIE_SECRET: z
    .string()
    .min(16)
    .default('gstflow-dev-cookie-secret-32chars!')
}).superRefine((data, ctx) => {
  // In production, DATABASE_URL is mandatory and must be a valid PostgreSQL URL
  if (data.NODE_ENV === 'production') {
    if (!data.DATABASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message: 'DATABASE_URL is required in production environment'
      });
    }

    // In production, enforce strong JWT secret and reject default dev secret
    if (
      !data.JWT_ACCESS_SECRET ||
      data.JWT_ACCESS_SECRET.length < 32 ||
      data.JWT_ACCESS_SECRET.includes('dev-access-jwt-secret')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_ACCESS_SECRET'],
        message: 'JWT_ACCESS_SECRET must be at least 32 characters and not use development defaults in production'
      });
    }

    if (
      !data.COOKIE_SECRET ||
      data.COOKIE_SECRET.length < 32 ||
      data.COOKIE_SECRET.includes('dev-cookie-secret')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['COOKIE_SECRET'],
        message: 'COOKIE_SECRET must be at least 32 characters and not use development defaults in production'
      });
    }
  }

  // If DATABASE_URL is provided in any environment, validate format
  if (data.DATABASE_URL) {
    const parseRes = PostgresUrlSchema.safeParse(data.DATABASE_URL);
    if (!parseRes.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message: 'DATABASE_URL must be a valid PostgreSQL connection URL'
      });
    }
  }

  // If REDIS_URL is provided, validate format
  if (data.REDIS_URL) {
    const parseRes = RedisUrlSchema.safeParse(data.REDIS_URL);
    if (!parseRes.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_URL'],
        message: 'REDIS_URL must be a valid Redis connection URL'
      });
    }
  }
});

export type EnvConfig = z.infer<typeof EnvSchema>;

let cachedEnv: EnvConfig | null = null;

/**
 * Validates the provided environment variables (defaults to process.env).
 * Throws ConfigurationError if validation fails, never exposing secrets.
 */
export function validateEnv(rawEnv: NodeJS.ProcessEnv = process.env): EnvConfig {
  const result = EnvSchema.safeParse(rawEnv);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const field = issue.path.join('.');
      return {
        field,
        message: issue.message
      };
    });

    const errorDetails = issues.map((i) => `  - ${i.field}: ${i.message}`).join('\n');
    throw new ConfigurationError(
      `Invalid environment configuration:\n${errorDetails}`,
      issues
    );
  }

  return result.data;
}

/**
 * Returns the cached validated environment configuration.
 * Loads and validates configuration on first access.
 */
export function getEnvConfig(): EnvConfig {
  if (!cachedEnv) {
    cachedEnv = validateEnv();
  }
  return cachedEnv;
}

/**
 * Resets the cached configuration (primarily for testing with custom configs).
 */
export function resetEnvConfig(): void {
  cachedEnv = null;
}
