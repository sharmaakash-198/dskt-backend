/**
 * Local authentication service.
 *
 * Responsibilities:
 * - Verify a username/password pair against the stored Argon2id hash.
 * - Create an opaque session token and store only its SHA-256 hash.
 * - Look up and validate a session from a token string.
 * - Revoke a session (sign-out).
 *
 * The local provider is development infrastructure; it must refuse to
 * initialise unless AUTH_ENV is explicitly 'local'.
 */
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import type { AppConfig } from '../config.js';
import { appUsers, localAuthCredentials, localAuthSessions } from '../db/schema.js';

export type AuthenticatedUser = {
  id: string;
  email: string;
  displayName: string;
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export class LocalAuthProvider {
  private readonly db: NodePgDatabase;
  private readonly ttlSeconds: number;

  constructor(pool: pg.Pool, config: AppConfig) {
    if (config.AUTH_ENV !== 'local') {
      throw new Error('LocalAuthProvider may only be instantiated when AUTH_ENV is "local".');
    }
    this.db = drizzle(pool);
    this.ttlSeconds = config.SESSION_TTL_SECONDS;
  }

  /** Verify credentials and return a fresh session token. Returns null on failure. */
  async signIn(
    username: string,
    password: string,
  ): Promise<{ token: string; user: AuthenticatedUser } | null> {
    // Look up credential + user in one join
    const rows = await this.db
      .select({
        userId: localAuthCredentials.appUserId,
        passwordHash: localAuthCredentials.passwordHash,
        disabledAt: localAuthCredentials.disabledAt,
        email: appUsers.email,
        displayName: appUsers.displayName,
        active: appUsers.active,
      })
      .from(localAuthCredentials)
      .innerJoin(appUsers, eq(localAuthCredentials.appUserId, appUsers.id))
      .where(eq(localAuthCredentials.username, username.toLowerCase()));

    const row = rows[0];

    // Compute hash even on miss to prevent timing oracle
    const dummyHash =
      '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQAAAAAAAAAAA$RdescudvJCsgt3ub+b+dWRWyebo/UPh+moJOFmn26Yg';
    const passwordHash = row?.passwordHash ?? dummyHash;
    const valid = await argon2.verify(passwordHash, password);

    if (!row || !valid || row.disabledAt !== null || !row.active) {
      return null;
    }

    const token = generateToken();
    const tokenHash = hashToken(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlSeconds * 1000);

    await this.db.insert(localAuthSessions).values({
      appUserId: row.userId,
      tokenHash,
      expiresAt,
    });

    // Update last_login_at
    await this.db.update(appUsers).set({ lastLoginAt: now }).where(eq(appUsers.id, row.userId));

    return {
      token,
      user: { id: row.userId, email: row.email, displayName: row.displayName },
    };
  }

  /** Validate a session token. Returns the user if valid, null otherwise. */
  async fromToken(token: string): Promise<AuthenticatedUser | null> {
    const tokenHash = hashToken(token);
    const now = new Date();

    const rows = await this.db
      .select({
        userId: localAuthSessions.appUserId,
        email: appUsers.email,
        displayName: appUsers.displayName,
        active: appUsers.active,
      })
      .from(localAuthSessions)
      .innerJoin(appUsers, eq(localAuthSessions.appUserId, appUsers.id))
      .where(
        and(
          eq(localAuthSessions.tokenHash, tokenHash),
          isNull(localAuthSessions.revokedAt),
          gt(localAuthSessions.expiresAt, now),
        ),
      );

    const row = rows[0];
    if (!row || !row.active) {
      return null;
    }

    return { id: row.userId, email: row.email, displayName: row.displayName };
  }

  /** Revoke a session token. No-op if already revoked or missing. */
  async revoke(token: string): Promise<void> {
    const tokenHash = hashToken(token);
    await this.db
      .update(localAuthSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(localAuthSessions.tokenHash, tokenHash), isNull(localAuthSessions.revokedAt)));
  }
}
