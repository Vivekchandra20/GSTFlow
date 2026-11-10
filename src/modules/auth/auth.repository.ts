import { PrismaClient, Prisma } from '@prisma/client';
import { UserEntity, RefreshSessionEntity, UserStatus } from './auth.types.js';

export interface CreateUserData {
  email: string;
  normalizedEmail: string;
  passwordHash: string;
}

export interface CreateRefreshSessionData {
  userId: string;
  tokenHash: string;
  tokenFamilyId: string;
  expiresAt: Date;
  userAgent?: string;
  ipAddress?: string;
}

export interface IAuthRepository {
  createUser(data: CreateUserData): Promise<UserEntity>;
  findUserByNormalizedEmail(normalizedEmail: string): Promise<UserEntity | null>;
  findUserById(userId: string): Promise<UserEntity | null>;
  updateUserStatus(userId: string, status: UserStatus): Promise<UserEntity>;
  createRefreshSession(data: CreateRefreshSessionData, tx?: any): Promise<RefreshSessionEntity>;
  findRefreshSessionByTokenHash(tokenHash: string, tx?: any): Promise<RefreshSessionEntity | null>;
  findRefreshSessionByTokenHashForUpdate(tokenHash: string, tx: any): Promise<RefreshSessionEntity | null>;
  rotateRefreshSession(
    oldSessionId: string,
    newSessionData: CreateRefreshSessionData,
    tx: any
  ): Promise<RefreshSessionEntity>;
  revokeSession(sessionId: string, tx?: any): Promise<void>;
  revokeTokenFamily(tokenFamilyId: string, tx?: any): Promise<number>;
  runInTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
}

export class PrismaAuthRepository implements IAuthRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async createUser(data: CreateUserData): Promise<UserEntity> {
    const user = await (this.prisma as any).user.create({
      data: {
        email: data.email,
        normalizedEmail: data.normalizedEmail,
        passwordHash: data.passwordHash,
        status: 'ACTIVE'
      }
    });

    return this.mapUser(user);
  }

  public async findUserByNormalizedEmail(normalizedEmail: string): Promise<UserEntity | null> {
    const user = await (this.prisma as any).user.findUnique({
      where: { normalizedEmail }
    });

    return user ? this.mapUser(user) : null;
  }

  public async findUserById(userId: string): Promise<UserEntity | null> {
    const user = await (this.prisma as any).user.findUnique({
      where: { id: userId }
    });

    return user ? this.mapUser(user) : null;
  }

  public async updateUserStatus(userId: string, status: UserStatus): Promise<UserEntity> {
    const user = await (this.prisma as any).user.update({
      where: { id: userId },
      data: { status }
    });

    return this.mapUser(user);
  }

  public async createRefreshSession(
    data: CreateRefreshSessionData,
    tx?: any
  ): Promise<RefreshSessionEntity> {
    const client = tx || this.prisma;
    const session = await (client as any).refreshSession.create({
      data: {
        userId: data.userId,
        tokenHash: data.tokenHash,
        tokenFamilyId: data.tokenFamilyId,
        expiresAt: data.expiresAt,
        userAgent: data.userAgent || null,
        ipAddress: data.ipAddress || null
      }
    });

    return this.mapSession(session);
  }

  public async findRefreshSessionByTokenHash(
    tokenHash: string,
    tx?: any
  ): Promise<RefreshSessionEntity | null> {
    const client = tx || this.prisma;
    const session = await (client as any).refreshSession.findUnique({
      where: { tokenHash }
    });

    return session ? this.mapSession(session) : null;
  }

  /**
   * Fetches the refresh session row with an exclusive row-level lock (FOR UPDATE).
   * Prevents concurrent refresh races from issuing duplicate descendant tokens.
   */
  public async findRefreshSessionByTokenHashForUpdate(
    tokenHash: string,
    tx: any
  ): Promise<RefreshSessionEntity | null> {
    const rows: any[] = await tx.$queryRawUnsafe(
      `SELECT id, user_id, token_hash, token_family_id, expires_at, revoked_at, replaced_by_session_id, user_agent, ip_address, last_used_at, created_at 
       FROM "refresh_sessions" 
       WHERE token_hash = $1 
       FOR UPDATE`,
      tokenHash
    );

    if (!rows || rows.length === 0) {
      return null;
    }

    const row = rows[0];
    return {
      id: row.id,
      userId: row.user_id,
      tokenHash: row.token_hash,
      tokenFamilyId: row.token_family_id,
      expiresAt: new Date(row.expires_at),
      revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
      replacedBySessionId: row.replaced_by_session_id || null,
      userAgent: row.user_agent || null,
      ipAddress: row.ip_address || null,
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
      createdAt: new Date(row.created_at)
    };
  }

  public async rotateRefreshSession(
    oldSessionId: string,
    newSessionData: CreateRefreshSessionData,
    tx: any
  ): Promise<RefreshSessionEntity> {
    // 1. Create the new descendant session
    const newSession = await (tx as any).refreshSession.create({
      data: {
        userId: newSessionData.userId,
        tokenHash: newSessionData.tokenHash,
        tokenFamilyId: newSessionData.tokenFamilyId,
        expiresAt: newSessionData.expiresAt,
        userAgent: newSessionData.userAgent || null,
        ipAddress: newSessionData.ipAddress || null
      }
    });

    // 2. Atomically mark old session as revoked and record replacement
    await (tx as any).refreshSession.update({
      where: { id: oldSessionId },
      data: {
        revokedAt: new Date(),
        lastUsedAt: new Date(),
        replacedBySessionId: newSession.id
      }
    });

    return this.mapSession(newSession);
  }

  public async revokeSession(sessionId: string, tx?: any): Promise<void> {
    const client = tx || this.prisma;
    await (client as any).refreshSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), lastUsedAt: new Date() }
    });
  }

  public async revokeTokenFamily(tokenFamilyId: string, tx?: any): Promise<number> {
    const client = tx || this.prisma;
    const result = await (client as any).refreshSession.updateMany({
      where: { tokenFamilyId, revokedAt: null },
      data: { revokedAt: new Date() }
    });
    return result.count;
  }

  public async runInTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return await this.prisma.$transaction(fn, {
      maxWait: 5000,
      timeout: 10000
    });
  }

  private mapUser(user: any): UserEntity {
    return {
      id: user.id,
      email: user.email,
      normalizedEmail: user.normalizedEmail,
      passwordHash: user.passwordHash,
      status: user.status as UserStatus,
      emailVerifiedAt: user.emailVerifiedAt ? new Date(user.emailVerifiedAt) : null,
      createdAt: new Date(user.createdAt),
      updatedAt: new Date(user.updatedAt)
    };
  }

  private mapSession(session: any): RefreshSessionEntity {
    return {
      id: session.id,
      userId: session.userId,
      tokenHash: session.tokenHash,
      tokenFamilyId: session.tokenFamilyId,
      expiresAt: new Date(session.expiresAt),
      revokedAt: session.revokedAt ? new Date(session.revokedAt) : null,
      replacedBySessionId: session.replacedBySessionId || null,
      userAgent: session.userAgent || null,
      ipAddress: session.ipAddress || null,
      lastUsedAt: session.lastUsedAt ? new Date(session.lastUsedAt) : null,
      createdAt: new Date(session.createdAt)
    };
  }
}
