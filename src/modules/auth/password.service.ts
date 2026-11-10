import argon2 from 'argon2';
import { getEnvConfig } from '../../config/env.js';

export interface PasswordServiceOptions {
  memoryCost?: number;
  timeCost?: number;
  parallelism?: number;
}

export class PasswordService {
  private readonly memoryCost: number;
  private readonly timeCost: number;
  private readonly parallelism: number;

  constructor(options: PasswordServiceOptions = {}) {
    const env = getEnvConfig();
    this.memoryCost = options.memoryCost ?? env.ARGON2_MEMORY_COST;
    this.timeCost = options.timeCost ?? env.ARGON2_TIME_COST;
    this.parallelism = options.parallelism ?? 4;
  }

  /**
   * Hashes a plaintext password using the Argon2id algorithm.
   */
  public async hash(plainPassword: string): Promise<string> {
    if (!plainPassword || plainPassword.length === 0) {
      throw new Error('Password cannot be empty');
    }

    return await argon2.hash(plainPassword, {
      type: argon2.argon2id,
      memoryCost: this.memoryCost,
      timeCost: this.timeCost,
      parallelism: this.parallelism
    });
  }

  /**
   * Verifies a candidate password against an Argon2id hash using a timing-safe comparison.
   */
  public async verify(hash: string, candidatePassword: string): Promise<boolean> {
    if (!hash || !candidatePassword) {
      return false;
    }

    try {
      return await argon2.verify(hash, candidatePassword);
    } catch {
      return false;
    }
  }
}
