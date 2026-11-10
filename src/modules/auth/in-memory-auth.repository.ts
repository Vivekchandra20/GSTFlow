import crypto from 'crypto';
import { UserEntity, RefreshSessionEntity, UserStatus } from './auth.types.js';
import { IAuthRepository, CreateUserData, CreateRefreshSessionData } from './auth.repository.js';

export class InMemoryAuthRepository implements IAuthRepository {
  private users: Map<string, UserEntity> = new Map();
  private usersByEmail: Map<string, string> = new Map();
  private refreshSessions: Map<string, RefreshSessionEntity> = new Map();
  private sessionsByTokenHash: Map<string, string> = new Map();

  public async createUser(data: CreateUserData): Promise<UserEntity> {
    if (this.usersByEmail.has(data.normalizedEmail)) {
      const err = new Error('Unique constraint failed on normalized_email');
      (err as any).code = 'P2002';
      throw err;
    }

    const id = crypto.randomUUID();
    const now = new Date();
    const user: UserEntity = {
      id,
      email: data.email,
      normalizedEmail: data.normalizedEmail,
      passwordHash: data.passwordHash,
      status: 'ACTIVE',
      emailVerifiedAt: null,
      createdAt: now,
      updatedAt: now
    };

    this.users.set(id, user);
    this.usersByEmail.set(data.normalizedEmail, id);
    return user;
  }

  public async findUserByNormalizedEmail(normalizedEmail: string): Promise<UserEntity | null> {
    const id = this.usersByEmail.get(normalizedEmail);
    if (!id) return null;
    return this.users.get(id) || null;
  }

  public async findUserById(userId: string): Promise<UserEntity | null> {
    return this.users.get(userId) || null;
  }

  public async updateUserStatus(userId: string, status: UserStatus): Promise<UserEntity> {
    const user = this.users.get(userId);
    if (!user) {
      throw new Error(`User with ID ${userId} not found`);
    }
    user.status = status;
    user.updatedAt = new Date();
    return user;
  }

  public async createRefreshSession(
    data: CreateRefreshSessionData,
    _tx?: any
  ): Promise<RefreshSessionEntity> {
    const id = crypto.randomUUID();
    const session: RefreshSessionEntity = {
      id,
      userId: data.userId,
      tokenHash: data.tokenHash,
      tokenFamilyId: data.tokenFamilyId,
      expiresAt: data.expiresAt,
      revokedAt: null,
      replacedBySessionId: null,
      userAgent: data.userAgent || null,
      ipAddress: data.ipAddress || null,
      lastUsedAt: null,
      createdAt: new Date()
    };

    this.refreshSessions.set(id, session);
    this.sessionsByTokenHash.set(data.tokenHash, id);
    return session;
  }

  public async findRefreshSessionByTokenHash(
    tokenHash: string,
    _tx?: any
  ): Promise<RefreshSessionEntity | null> {
    const id = this.sessionsByTokenHash.get(tokenHash);
    if (!id) return null;
    return this.refreshSessions.get(id) || null;
  }

  public async findRefreshSessionByTokenHashForUpdate(
    tokenHash: string,
    tx: any
  ): Promise<RefreshSessionEntity | null> {
    return this.findRefreshSessionByTokenHash(tokenHash, tx);
  }

  public async rotateRefreshSession(
    oldSessionId: string,
    newSessionData: CreateRefreshSessionData,
    _tx: any
  ): Promise<RefreshSessionEntity> {
    const old = this.refreshSessions.get(oldSessionId);
    if (old) {
      old.revokedAt = new Date();
      old.lastUsedAt = new Date();
    }

    const newSession = await this.createRefreshSession(newSessionData);
    if (old) {
      old.replacedBySessionId = newSession.id;
    }
    return newSession;
  }

  public async revokeSession(sessionId: string, _tx?: any): Promise<void> {
    const session = this.refreshSessions.get(sessionId);
    if (session && !session.revokedAt) {
      session.revokedAt = new Date();
      session.lastUsedAt = new Date();
    }
  }

  public async revokeTokenFamily(tokenFamilyId: string, _tx?: any): Promise<number> {
    let count = 0;
    const now = new Date();
    for (const session of this.refreshSessions.values()) {
      if (session.tokenFamilyId === tokenFamilyId && !session.revokedAt) {
        session.revokedAt = now;
        count++;
      }
    }
    return count;
  }

  public async runInTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    // In-memory sequential transaction emulation
    return await fn(this);
  }

  public clear(): void {
    this.users.clear();
    this.usersByEmail.clear();
    this.refreshSessions.clear();
    this.sessionsByTokenHash.clear();
  }
}
