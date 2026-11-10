import { describe, it, expect } from 'vitest';
import { PasswordService } from '../../../src/modules/auth/password.service.js';

describe('PasswordService (Argon2id)', () => {
  const passwordService = new PasswordService();

  it('hashes a password using Argon2id producing a valid hash format', async () => {
    const rawPassword = 'StrongPassword123!';
    const hash = await passwordService.hash(rawPassword);

    expect(hash).toBeDefined();
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).toContain('m=65536');
    expect(hash).toContain('t=3');
    expect(hash).toContain('p=4');
  });

  it('verifies a valid password against its hash', async () => {
    const password = 'CorrectPassword999';
    const hash = await passwordService.hash(password);

    const isValid = await passwordService.verify(hash, password);
    expect(isValid).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const password = 'CorrectPassword999';
    const hash = await passwordService.hash(password);

    const isValid = await passwordService.verify(hash, 'WrongPassword999');
    expect(isValid).toBe(false);
  });

  it('returns false for malformed or corrupted hashes without throwing unhandled exceptions', async () => {
    const isValid = await passwordService.verify('invalid-hash-format', 'Password123');
    expect(isValid).toBe(false);
  });

  it('produces distinct salt and hashes for identical passwords', async () => {
    const password = 'SamePassword123';
    const hash1 = await passwordService.hash(password);
    const hash2 = await passwordService.hash(password);

    expect(hash1).not.toBe(hash2);
    expect(await passwordService.verify(hash1, password)).toBe(true);
    expect(await passwordService.verify(hash2, password)).toBe(true);
  });
});
