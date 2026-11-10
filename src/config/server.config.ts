import { FastifyServerOptions } from 'fastify';
import { FastifyCorsOptions } from '@fastify/cors';
import { FastifyHelmetOptions } from '@fastify/helmet';
import { EnvConfig } from './env.js';
import { sanitizeLogPayload } from '../utils/logger.js';

export interface ServerConfig {
  env: EnvConfig;
  fastifyOptions: FastifyServerOptions;
  corsOptions: FastifyCorsOptions;
  helmetOptions: FastifyHelmetOptions;
  healthTimeoutMs: number;
}

/**
 * Builds the typed server configuration from validated environment settings.
 */
export function buildServerConfig(env: EnvConfig): ServerConfig {
  // CORS origin configuration
  let originSetting: FastifyCorsOptions['origin'] = false;
  let credentialsSetting = false;

  if (env.CORS_ORIGIN === '*') {
    if (env.NODE_ENV !== 'production') {
      originSetting = [
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'http://localhost:3000',
        'http://127.0.0.1:3000'
      ];
      credentialsSetting = true;
    } else {
      originSetting = '*';
      credentialsSetting = false;
    }
  } else if (env.CORS_ORIGIN.includes(',')) {
    originSetting = env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
    credentialsSetting = true;
  } else if (env.CORS_ORIGIN.length > 0) {
    originSetting = env.CORS_ORIGIN.trim();
    credentialsSetting = true;
  }

  const corsOptions: FastifyCorsOptions = {
    origin: originSetting,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'Accept'],
    exposedHeaders: ['X-Request-Id'],
    credentials: credentialsSetting,
    maxAge: 86400 // 24 hours
  };

  const helmetOptions: FastifyHelmetOptions = {
    contentSecurityPolicy: env.NODE_ENV === 'production' ? {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        fontSrc: ["'self'", 'https:', 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", 'https:', "'unsafe-inline'"],
        upgradeInsecureRequests: []
      }
    } : false,
    crossOriginEmbedderPolicy: false,
    hidePoweredBy: true,
    hsts: env.NODE_ENV === 'production' ? {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true
    } : false,
    frameguard: {
      action: 'deny'
    },
    noSniff: true,
    xssFilter: true
  };

  const fastifyOptions: FastifyServerOptions = {
    loggerInstance: undefined,
    logger: env.NODE_ENV === 'test' ? false : {
      level: env.LOG_LEVEL,
      serializers: {
        req(req: any) {
          return {
            method: req.method,
            url: req.url,
            path: req.routeOptions?.url || req.url,
            parameters: req.params,
            headers: sanitizeLogPayload(req.headers)
          };
        },
        res(res: any) {
          return {
            statusCode: res.statusCode
          };
        }
      },
      formatters: {
        log(obj: Record<string, any>) {
          return sanitizeLogPayload(obj);
        }
      },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-api-key"]',
          'req.headers.cookie',
          'req.headers["set-cookie"]',
          'headers.authorization',
          'headers.cookie',
          '*.password',
          '*.secret',
          '*.token'
        ],
        censor: '[REDACTED]'
      }
    },
    bodyLimit: env.BODY_LIMIT,
    connectionTimeout: env.REQUEST_TIMEOUT_MS,
    requestTimeout: env.REQUEST_TIMEOUT_MS,
    trustProxy: env.NODE_ENV === 'production'
  };

  return {
    env,
    fastifyOptions,
    corsOptions,
    helmetOptions,
    healthTimeoutMs: env.HEALTH_CHECK_TIMEOUT_MS
  };
}
