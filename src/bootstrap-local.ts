#!/usr/bin/env node
/**
 * bootstrap-local
 *
 * One-time seeder for local development. Creates the first System Admin:
 *   - The Arrise organization (if absent)
 *   - A synthetic System Admin app_user
 *   - A local identity (provider_subject = username)
 *   - An Argon2id credential
 *
 * Run once:
 *   npm run bootstrap-local -- --username admin --password <password>
 *
 * Refuses to run when a System Administrator already exists. Further users
 * are created through the Access administration workspace. The password is
 * accepted only at the command line and is never stored as plain text.
 */
import argon2 from 'argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { parseArgs } from 'node:util';
import {
  appUserIdentities,
  appUserRoles,
  appUsers,
  localAuthCredentials,
  organizations,
  roles,
} from './db/schema.js';

export const DEFAULT_SYNTHETIC_USERS = [
  {
    username: 'admin',
    displayName: 'Local System Administrator',
    email: 'admin@arrise.local',
    password: process.env.DSKT_ADMIN_PASSWORD || 'dskt-local-admin',
    roleCode: 'SYSTEM_ADMIN' as const,
  },
  {
    username: 'facilities',
    displayName: 'Local Facilities Admin',
    email: 'facilities@arrise.local',
    password: process.env.DSKT_FACILITIES_PASSWORD || 'dskt-local-facilities',
    roleCode: 'FACILITIES_ADMIN' as const,
  },
  {
    username: 'planner',
    displayName: 'Local Workplace Planner',
    email: 'planner@arrise.local',
    password: process.env.DSKT_PLANNER_PASSWORD || 'dskt-local-planner',
    roleCode: 'WORKPLACE_PLANNER' as const,
  },
  {
    username: 'viewer',
    displayName: 'Local Viewer',
    email: 'viewer@arrise.local',
    password: process.env.DSKT_VIEWER_PASSWORD || 'dskt-local-viewer',
    roleCode: 'VIEWER' as const,
  },
];

export async function bootstrapSyntheticUsers(dbInstance: ReturnType<typeof drizzle>): Promise<void> {
  await dbInstance.transaction(async (tx) => {
    // 1. Ensure Arrise organization exists
    const existingOrgs = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.name, 'Arrise'));

    let orgId: string;
    if (existingOrgs.length === 0) {
      const inserted = await tx
        .insert(organizations)
        .values({ name: 'Arrise' })
        .returning({ id: organizations.id });
      orgId = inserted[0]!.id;
      console.log('Created organization: Arrise');
    } else {
      orgId = existingOrgs[0]!.id;
    }

    // 2. Fetch all role IDs
    const roleRows = await tx.select({ id: roles.id, code: roles.code }).from(roles);
    const roleMap = new Map(roleRows.map((r) => [r.code, r.id]));

    for (const u of DEFAULT_SYNTHETIC_USERS) {
      const roleId = roleMap.get(u.roleCode);
      if (!roleId) {
        console.warn(`Role ${u.roleCode} not found in database. Skipping ${u.username}.`);
        continue;
      }

      // Check if user credentials exist
      const existing = await tx
        .select({ appUserId: localAuthCredentials.appUserId })
        .from(localAuthCredentials)
        .where(eq(localAuthCredentials.username, u.username.toLowerCase()));

      let userId: string;
      if (existing.length > 0) {
        userId = existing[0]!.appUserId;
      } else {
        const insertedUser = await tx
          .insert(appUsers)
          .values({
            organizationId: orgId,
            email: u.email.toLowerCase(),
            displayName: u.displayName,
            active: true,
          })
          .returning({ id: appUsers.id });
        userId = insertedUser[0]!.id;

        await tx.insert(appUserIdentities).values({
          appUserId: userId,
          provider: 'LOCAL',
          providerSubject: u.username.toLowerCase(),
        });

        const passwordHash = await argon2.hash(u.password, { type: argon2.argon2id });
        await tx.insert(localAuthCredentials).values({
          appUserId: userId,
          username: u.username.toLowerCase(),
          passwordHash,
        });
        console.log(`Bootstrapped synthetic user: ${u.username} (${u.roleCode})`);
      }

      // Ensure active role assignment
      const existingRole = await tx
        .select({ appUserId: appUserRoles.appUserId })
        .from(appUserRoles)
        .where(
          and(
            eq(appUserRoles.appUserId, userId),
            eq(appUserRoles.roleId, roleId),
            isNull(appUserRoles.revokedAt),
          ),
        );

      if (existingRole.length === 0) {
        await tx.insert(appUserRoles).values({
          appUserId: userId,
          roleId,
          grantedByUserId: userId,
        });
        console.log(`Granted ${u.roleCode} to ${u.username}.`);
      }
    }
  });
}

export async function runCli(): Promise<void> {
  const { values } = parseArgs({
    options: {
      username: { type: 'string' },
      password: { type: 'string' },
      email: { type: 'string' },
      'display-name': { type: 'string' },
      'synthetic-defaults': { type: 'boolean' },
    },
    strict: false,
  });

  const isSyntheticDefaults = Boolean(values['synthetic-defaults'] || process.env.BOOTSTRAP_SYNTHETIC_USERS === 'true');
  const username = typeof values['username'] === 'string' ? values['username'] : undefined;
  const password = typeof values['password'] === 'string' ? values['password'] : undefined;
  const email = (typeof values['email'] === 'string' ? values['email'] : undefined) ?? `${username ?? ''}@local.dskt`;
  const displayName = (typeof values['display-name'] === 'string' ? values['display-name'] : undefined) ?? username ?? '';

  if (!isSyntheticDefaults && (!username || !password)) {
    console.error('Usage: npm run bootstrap-local -- --username <u> --password <p>');
    console.error('   or: npm run bootstrap-local -- --synthetic-defaults');
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required.');
    process.exit(1);
  }

  const authEnv = process.env.AUTH_ENV ?? 'local';
  if (authEnv !== 'local') {
    console.error('bootstrap-local may only run when AUTH_ENV=local.');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const db = drizzle(pool);

  try {
    if (isSyntheticDefaults) {
      await bootstrapSyntheticUsers(db);
      console.log('All synthetic users bootstrapped successfully.');
    } else {
      await db.transaction(async (tx) => {
        // Upsert organization
        const existingOrgs = await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.name, 'Arrise'));

        let orgId: string;
        if (existingOrgs.length === 0) {
          const inserted = await tx
            .insert(organizations)
            .values({ name: 'Arrise' })
            .returning({ id: organizations.id });
          orgId = inserted[0]!.id;
          console.log('Created organization: Arrise');
        } else {
          orgId = existingOrgs[0]!.id;
          console.log('Organization already exists: Arrise');
        }

        // One-time bootstrap: refuse if any System Administrator already exists.
        const adminRoleRows = await tx
          .select({ id: roles.id })
          .from(roles)
          .where(eq(roles.code, 'SYSTEM_ADMIN'));
        const adminRoleId = adminRoleRows[0]?.id;
        if (adminRoleId !== undefined) {
          const existingAdmins = await tx
            .select({ appUserId: appUserRoles.appUserId })
            .from(appUserRoles)
            .where(and(eq(appUserRoles.roleId, adminRoleId), isNull(appUserRoles.revokedAt)));
          if (existingAdmins.length > 0) {
            console.error(
              'A local System Administrator already exists. Use the Access administration workspace for further users.',
            );
            process.exitCode = 1;
            return;
          }
        }

        if (adminRoleId === undefined) {
          console.error('SYSTEM_ADMIN role is missing from the database. Apply migrations first.');
          process.exitCode = 1;
          return;
        }

        // Check if user exists
        const existing = await tx
          .select({ appUserId: localAuthCredentials.appUserId })
          .from(localAuthCredentials)
          .where(eq(localAuthCredentials.username, username!.toLowerCase()));

        let userId: string;
        if (existing.length > 0) {
          // Credentials exist but no System Admin yet — complete one-time bootstrap.
          userId = existing[0]!.appUserId;
          console.log(`User "${username}" already exists. Granting SYSTEM_ADMIN to complete bootstrap.`);
        } else {
          const insertedUsers = await tx
            .insert(appUsers)
            .values({
              organizationId: orgId,
              email: email.toLowerCase(),
              displayName: displayName!,
              active: true,
            })
            .returning({ id: appUsers.id });
          userId = insertedUsers[0]!.id;

          await tx.insert(appUserIdentities).values({
            appUserId: userId,
            provider: 'LOCAL',
            providerSubject: username!.toLowerCase(),
          });

          const passwordHash = await argon2.hash(password!, { type: argon2.argon2id });
          await tx.insert(localAuthCredentials).values({
            appUserId: userId,
            username: username!.toLowerCase(),
            passwordHash,
          });

          console.log(`Created local user: ${username} (${email})`);
        }

        await tx.insert(appUserRoles).values({
          appUserId: userId,
          roleId: adminRoleId,
          grantedByUserId: userId,
        });

        console.log('SYSTEM_ADMIN role granted.');
      });
    }
  } finally {
    await pool.end();
  }

  if (process.exitCode && process.exitCode !== 0) {
    process.exit(process.exitCode);
  }
}

if (process.argv[1]?.includes('bootstrap-local')) {
  void runCli();
}
