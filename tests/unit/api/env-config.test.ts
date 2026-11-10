import { describe, it, expect, beforeEach } from 'vitest';
import { validateEnv, getEnvConfig, resetEnvConfig, ConfigurationError } from '../../../src/config/env.js';

describe('Phase 4.2.1: Environment Configuration Unit Tests', () => {
  beforeEach(() => {
    resetEnvConfig();
  });

  it('accepts valid configuration and applies sensible defaults', () => {
    const config = validateEnv({
      NODE_ENV: 'development',
      PORT: '4000',
      HOST: '127.0.0.1',
      DATABASE_URL: 'postgresql://postgres:pass@localhost:5432/gstflow_dev',
      REDIS_URL: 'redis://localhost:6379',
      LOG_LEVEL: 'debug',
      CORS_ORIGIN: 'http://localhost:3000',
      BODY_LIMIT: '2097152',
      REQUEST_TIMEOUT_MS: '45000'
    });

    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(4000);
    expect(config.HOST).toBe('127.0.0.1');
    expect(config.DATABASE_URL).toBe('postgresql://postgres:pass@localhost:5432/gstflow_dev');
    expect(config.REDIS_URL).toBe('redis://localhost:6379');
    expect(config.LOG_LEVEL).toBe('debug');
    expect(config.CORS_ORIGIN).toBe('http://localhost:3000');
    expect(config.BODY_LIMIT).toBe(2097152);
    expect(config.REQUEST_TIMEOUT_MS).toBe(45000);
  });

  it('applies default values when optional variables are omitted', () => {
    const config = validateEnv({});

    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(3000);
    expect(config.HOST).toBe('0.0.0.0');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.CORS_ORIGIN).toBe('*');
    expect(config.BODY_LIMIT).toBe(1048576);
    expect(config.REQUEST_TIMEOUT_MS).toBe(30000);
    expect(config.HEALTH_CHECK_TIMEOUT_MS).toBe(2000);
  });

  it('rejects port below 1 or above 65535', () => {
    expect(() => validateEnv({ PORT: '0' })).toThrow(ConfigurationError);
    expect(() => validateEnv({ PORT: '70000' })).toThrow(ConfigurationError);
    expect(() => validateEnv({ PORT: 'not-a-number' })).toThrow(ConfigurationError);
  });

  it('rejects invalid DATABASE_URL scheme', () => {
    expect(() =>
      validateEnv({ DATABASE_URL: 'mysql://user:pass@localhost:3306/db' })
    ).toThrow(ConfigurationError);

    expect(() =>
      validateEnv({ DATABASE_URL: 'not-a-valid-url' })
    ).toThrow(ConfigurationError);
  });

  it('rejects invalid REDIS_URL scheme', () => {
    expect(() =>
      validateEnv({ REDIS_URL: 'http://localhost:6379' })
    ).toThrow(ConfigurationError);
  });

  it('mandates DATABASE_URL when NODE_ENV is production', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'production'
      })
    ).toThrow(ConfigurationError);

    // Valid production config with DATABASE_URL and production secrets
    const prodConfig = validateEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://prod_user:secret_pass@db.internal:5432/gstflow_prod',
      JWT_ACCESS_SECRET: 'prod-jwt-secret-with-more-than-32-chars-long!',
      COOKIE_SECRET: 'prod-cookie-secret-with-more-than-32-chars-long!'
    });
    expect(prodConfig.NODE_ENV).toBe('production');
  });

  it('does not print passwords or credentials in ConfigurationError message', () => {
    const secretPass = 'SuperSecretDbPassword123!';
    try {
      validateEnv({
        DATABASE_URL: `invalid-scheme://admin:${secretPass}@db.example.com/db`
      });
      expect.fail('Expected ConfigurationError to be thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(ConfigurationError);
      expect(err.message).not.toContain(secretPass);
    }
  });

  it('caches validated environment in getEnvConfig and respects resetEnvConfig', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'test';
      resetEnvConfig();
      const cfg1 = getEnvConfig();
      expect(cfg1.NODE_ENV).toBe('test');

      // Modifying process.env without reset returns cached config
      process.env.NODE_ENV = 'production';
      const cfg2 = getEnvConfig();
      expect(cfg2.NODE_ENV).toBe('test');

      // After reset, fresh config is loaded
      resetEnvConfig();
      expect(() => getEnvConfig()).toThrow(ConfigurationError); // Throws because prod requires DATABASE_URL
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      resetEnvConfig();
    }
  });
});
