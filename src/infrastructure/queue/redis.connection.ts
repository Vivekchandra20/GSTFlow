import Redis, { RedisOptions } from 'ioredis';
import { pino } from 'pino';

const logger = pino({ name: 'redis-connection' });

export interface RedisConnectionConfig {
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  maxRetriesPerRequest?: number | null;
  enableReadyCheck?: boolean;
  useMock?: boolean;
}

export class RedisConnectionManager {
  private static instance: RedisConnectionManager | null = null;
  private client: Redis | null = null;
  private isShuttingDown: boolean = false;

  private constructor(private readonly config: RedisConnectionConfig = {}) {}

  public static getInstance(config?: RedisConnectionConfig): RedisConnectionManager {
    if (!RedisConnectionManager.instance) {
      RedisConnectionManager.instance = new RedisConnectionManager(config);
    }
    return RedisConnectionManager.instance;
  }

  public static resetInstance(): void {
    if (RedisConnectionManager.instance) {
      RedisConnectionManager.instance.close();
      RedisConnectionManager.instance = null;
    }
  }

  public getClient(): Redis {
    if (this.client) {
      return this.client;
    }

    const useMock = this.config.useMock ?? (process.env.USE_MOCK_REDIS === 'true');

    if (useMock) {
      logger.info('Initializing in-memory RedisMock connection for tests/development.');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const RedisMock = require('ioredis-mock');
      this.client = new RedisMock() as unknown as Redis;
      return this.client;
    }

    const redisUrl = this.config.url || process.env.REDIS_URL;
    const options: RedisOptions = {
      maxRetriesPerRequest: this.config.maxRetriesPerRequest ?? null, // Required by BullMQ
      enableReadyCheck: this.config.enableReadyCheck ?? false,
      lazyConnect: true,
      retryStrategy: (times) => {
        if (this.isShuttingDown) return null;
        const delay = Math.min(times * 200, 2000);
        return delay;
      }
    };

    if (redisUrl) {
      this.client = new Redis(redisUrl, options);
    } else {
      this.client = new Redis({
        host: this.config.host || process.env.REDIS_HOST || '127.0.0.1',
        port: this.config.port || Number(process.env.REDIS_PORT) || 6379,
        password: this.config.password || process.env.REDIS_PASSWORD || undefined,
        db: this.config.db || Number(process.env.REDIS_DB) || 0,
        ...options
      });
    }

    this.client.on('error', (err) => {
      if (!this.isShuttingDown) {
        logger.error({ err: err.message }, 'Redis client connection error');
      }
    });

    this.client.on('connect', () => {
      logger.info('Connected to Redis');
    });

    return this.client;
  }

  public async close(): Promise<void> {
    this.isShuttingDown = true;
    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        this.client.disconnect();
      }
      this.client = null;
    }
    this.isShuttingDown = false;
  }
}
