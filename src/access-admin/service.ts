/**
 * Local access-administration operations for System Administrators.
 *
 * Creates provider-neutral application users with local identities, grants and
 * revokes product roles, deactivates users, and reclaims editor leases.
 * All mutations are transactional and emit safe audit events.
 */
import argon2 from 'argon2';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import {
  appUserIdentities,
  appUserRoles,
  appUsers,
  auditEvents,
  editorLeases,
  localAuthCredentials,
  localAuthSessions,
  organizations,
  roles,
} from '../db/schema.js';
import { isRoleCode, type RoleCode } from '../auth/principal.js';

export const GRANTABLE_ROLES = [
  'FACILITIES_ADMIN',
  'WORKPLACE_PLANNER',
  'VIEWER',
] as const satisfies readonly RoleCode[];

export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

export function isGrantableRole(value: string): value is GrantableRole {
  return (GRANTABLE_ROLES as readonly string[]).includes(value);
}

export type ManagedUser = {
  id: string;
  email: string;
  displayName: string;
  active: boolean;
};

export type ManagedUserView = {
  user: ManagedUser;
  roles: RoleCode[];
};

export class AccessAdminError extends Error {
  constructor(
    readonly code:
      | 'user_not_found'
      | 'role_already_granted'
      | 'role_not_granted'
      | 'role_not_grantable'
      | 'username_taken'
      | 'email_taken'
      | 'user_already_inactive'
      | 'user_still_active'
      | 'organization_missing',
  ) {
    super(code);
    this.name = 'AccessAdminError';
  }
}

type AuditWrite = {
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  correlationId: string;
  summary: string;
};

export class AccessAdminService {
  private readonly db: NodePgDatabase;

  constructor(pool: pg.Pool) {
    this.db = drizzle(pool);
  }

  async listUsers(): Promise<ManagedUserView[]> {
    const users = await this.db
      .select({
        id: appUsers.id,
        email: appUsers.email,
        displayName: appUsers.displayName,
        active: appUsers.active,
      })
      .from(appUsers)
      .orderBy(asc(appUsers.email));

    const result: ManagedUserView[] = [];
    for (const user of users) {
      result.push({
        user,
        roles: await this.loadActiveRoles(user.id),
      });
    }
    return result;
  }

  async createLocalUser(input: {
    actorUserId: string;
    correlationId: string;
    email: string;
    displayName: string;
    username: string;
    password: string;
  }): Promise<ManagedUserView> {
    return this.db.transaction(async (tx) => {
      const orgRows = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.name, 'Arrise'));
      const orgId = orgRows[0]?.id;
      if (!orgId) {
        throw new AccessAdminError('organization_missing');
      }

      const email = input.email.toLowerCase();
      const username = input.username.toLowerCase();

      const emailClash = await tx
        .select({ id: appUsers.id })
        .from(appUsers)
        .where(eq(appUsers.email, email));
      if (emailClash.length > 0) {
        throw new AccessAdminError('email_taken');
      }

      const usernameClash = await tx
        .select({ appUserId: localAuthCredentials.appUserId })
        .from(localAuthCredentials)
        .where(eq(localAuthCredentials.username, username));
      if (usernameClash.length > 0) {
        throw new AccessAdminError('username_taken');
      }

      const inserted = await tx
        .insert(appUsers)
        .values({
          organizationId: orgId,
          email,
          displayName: input.displayName,
          active: true,
        })
        .returning({
          id: appUsers.id,
          email: appUsers.email,
          displayName: appUsers.displayName,
          active: appUsers.active,
        });
      const user = inserted[0]!;

      await tx.insert(appUserIdentities).values({
        appUserId: user.id,
        provider: 'LOCAL',
        providerSubject: username,
      });

      const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
      await tx.insert(localAuthCredentials).values({
        appUserId: user.id,
        username,
        passwordHash,
      });

      await this.writeAudit(tx, {
        actorUserId: input.actorUserId,
        action: 'user.created',
        targetType: 'app_user',
        targetId: user.id,
        correlationId: input.correlationId,
        summary: `Created local application user ${email}`,
      });

      return { user, roles: [] };
    });
  }

  async grantRole(input: {
    actorUserId: string;
    correlationId: string;
    targetUserId: string;
    role: GrantableRole;
  }): Promise<ManagedUserView> {
    return this.db.transaction(async (tx) => {
      const user = await this.requireUser(tx, input.targetUserId);
      const roleId = await this.requireRoleId(tx, input.role);

      const active = await tx
        .select({ roleId: appUserRoles.roleId })
        .from(appUserRoles)
        .where(
          and(
            eq(appUserRoles.appUserId, input.targetUserId),
            eq(appUserRoles.roleId, roleId),
            isNull(appUserRoles.revokedAt),
          ),
        );
      if (active.length > 0) {
        throw new AccessAdminError('role_already_granted');
      }

      await tx.insert(appUserRoles).values({
        appUserId: input.targetUserId,
        roleId,
        grantedByUserId: input.actorUserId,
      });

      await this.writeAudit(tx, {
        actorUserId: input.actorUserId,
        action: 'role.granted',
        targetType: 'app_user',
        targetId: input.targetUserId,
        correlationId: input.correlationId,
        summary: `Granted ${input.role}`,
      });

      return {
        user,
        roles: await this.loadActiveRoles(input.targetUserId, tx),
      };
    });
  }

  async revokeRole(input: {
    actorUserId: string;
    correlationId: string;
    targetUserId: string;
    role: GrantableRole;
  }): Promise<ManagedUserView> {
    return this.db.transaction(async (tx) => {
      const user = await this.requireUser(tx, input.targetUserId);
      const roleId = await this.requireRoleId(tx, input.role);

      const active = await tx
        .select({ grantedAt: appUserRoles.grantedAt })
        .from(appUserRoles)
        .where(
          and(
            eq(appUserRoles.appUserId, input.targetUserId),
            eq(appUserRoles.roleId, roleId),
            isNull(appUserRoles.revokedAt),
          ),
        );
      if (active.length === 0) {
        throw new AccessAdminError('role_not_granted');
      }

      await tx
        .update(appUserRoles)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(appUserRoles.appUserId, input.targetUserId),
            eq(appUserRoles.roleId, roleId),
            isNull(appUserRoles.revokedAt),
          ),
        );

      await this.writeAudit(tx, {
        actorUserId: input.actorUserId,
        action: 'role.revoked',
        targetType: 'app_user',
        targetId: input.targetUserId,
        correlationId: input.correlationId,
        summary: `Revoked ${input.role}`,
      });

      return {
        user,
        roles: await this.loadActiveRoles(input.targetUserId, tx),
      };
    });
  }

  async deactivateUser(input: {
    actorUserId: string;
    correlationId: string;
    targetUserId: string;
  }): Promise<ManagedUserView & { editorLeasesReclaimable: boolean }> {
    return this.db.transaction(async (tx) => {
      const user = await this.requireUser(tx, input.targetUserId);
      if (!user.active) {
        throw new AccessAdminError('user_already_inactive');
      }

      const now = new Date();
      await tx
        .update(appUsers)
        .set({ active: false, updatedAt: now })
        .where(eq(appUsers.id, input.targetUserId));

      await tx
        .update(localAuthCredentials)
        .set({ disabledAt: now })
        .where(eq(localAuthCredentials.appUserId, input.targetUserId));

      await tx
        .update(localAuthSessions)
        .set({ revokedAt: now })
        .where(
          and(
            eq(localAuthSessions.appUserId, input.targetUserId),
            isNull(localAuthSessions.revokedAt),
          ),
        );

      const activeLeases = await tx
        .select({ id: editorLeases.id })
        .from(editorLeases)
        .where(
          and(eq(editorLeases.appUserId, input.targetUserId), isNull(editorLeases.releasedAt)),
        );

      if (activeLeases.length > 0) {
        await tx
          .update(editorLeases)
          .set({ reclaimableAt: now })
          .where(
            and(eq(editorLeases.appUserId, input.targetUserId), isNull(editorLeases.releasedAt)),
          );
      }

      await this.writeAudit(tx, {
        actorUserId: input.actorUserId,
        action: 'user.deactivated',
        targetType: 'app_user',
        targetId: input.targetUserId,
        correlationId: input.correlationId,
        summary: 'Deactivated application user; editor leases marked reclaimable',
      });

      return {
        user: { ...user, active: false },
        roles: await this.loadActiveRoles(input.targetUserId, tx),
        editorLeasesReclaimable: activeLeases.length > 0,
      };
    });
  }

  async reclaimEditorLeases(input: {
    actorUserId: string;
    correlationId: string;
    targetUserId: string;
  }): Promise<{ reclaimed: number }> {
    return this.db.transaction(async (tx) => {
      const user = await this.requireUser(tx, input.targetUserId);
      if (user.active) {
        throw new AccessAdminError('user_still_active');
      }

      const reclaimable = await tx
        .select({ id: editorLeases.id })
        .from(editorLeases)
        .where(
          and(
            eq(editorLeases.appUserId, input.targetUserId),
            isNull(editorLeases.releasedAt),
          ),
        );

      const now = new Date();
      if (reclaimable.length > 0) {
        await tx
          .update(editorLeases)
          .set({ releasedAt: now, reclaimableAt: now })
          .where(
            and(
              eq(editorLeases.appUserId, input.targetUserId),
              isNull(editorLeases.releasedAt),
            ),
          );
      }

      await this.writeAudit(tx, {
        actorUserId: input.actorUserId,
        action: 'editor_lease.reclaimed',
        targetType: 'app_user',
        targetId: input.targetUserId,
        correlationId: input.correlationId,
        summary: `Reclaimed ${reclaimable.length} editor lease(s)`,
      });

      return { reclaimed: reclaimable.length };
    });
  }

  private async requireUser(
    tx: NodePgDatabase,
    userId: string,
  ): Promise<ManagedUser> {
    const rows = await tx
      .select({
        id: appUsers.id,
        email: appUsers.email,
        displayName: appUsers.displayName,
        active: appUsers.active,
      })
      .from(appUsers)
      .where(eq(appUsers.id, userId));
    const user = rows[0];
    if (!user) {
      throw new AccessAdminError('user_not_found');
    }
    return user;
  }

  private async requireRoleId(tx: NodePgDatabase, code: GrantableRole): Promise<number> {
    const rows = await tx.select({ id: roles.id }).from(roles).where(eq(roles.code, code));
    const roleId = rows[0]?.id;
    if (roleId === undefined) {
      throw new AccessAdminError('role_not_grantable');
    }
    return roleId;
  }

  private async loadActiveRoles(
    appUserId: string,
    tx: NodePgDatabase = this.db,
  ): Promise<RoleCode[]> {
    const rows = await tx
      .select({ code: roles.code })
      .from(appUserRoles)
      .innerJoin(roles, eq(appUserRoles.roleId, roles.id))
      .where(and(eq(appUserRoles.appUserId, appUserId), isNull(appUserRoles.revokedAt)));

    const effective: RoleCode[] = [];
    for (const row of rows) {
      if (isRoleCode(row.code)) {
        effective.push(row.code);
      }
    }
    return effective.sort();
  }

  private async writeAudit(tx: NodePgDatabase, event: AuditWrite): Promise<void> {
    await tx.insert(auditEvents).values({
      actorUserId: event.actorUserId,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      correlationId: event.correlationId,
      summary: event.summary,
    });
  }
}
