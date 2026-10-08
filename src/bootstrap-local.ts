#!/usr/bin/env node
/**
 * bootstrap-local
 *
 * One-time seeder for local development. Creates:
 *   - The Arrise organization (if absent)
 *   - A synthetic System Admin app_user
 *   - A local identity (provider_subject = username)
 *   - An Argon2id credential
 *
 * Run:
 *   npm run bootstrap-local -- --username admin --password <password>
 *
 * The password is accepted only at the command line and is never stored
 * as plain text. Do not commit passwords.
 */
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
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

const { values } = parseArgs({
  options: {
    username: { type: 'string' },
    password: { type: 'string' },
    email: { type: 'string' },
    'display-name': { type: 'string' },
  },
});

const username = values['username'];
const password = values['password'];
const email = values['email'] ?? `${username}@local.dskt`;
const displayName = values['display-name'] ?? username;

if (!username || !password) {
  console.error('Usage: npm run bootstrap-local -- --username <u> --password <p>');
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

    // Check if user exists
    const existing = await tx
      .select({ id: localAuthCredentials.appUserId })
      .from(localAuthCredentials)
      .where(eq(localAuthCredentials.username, username.toLowerCase()));

    if (existing.length > 0) {
      console.log(`User "${username}" already exists. Nothing to do.`);
      return;
    }

    // Create app_user
    const insertedUsers = await tx
      .insert(appUsers)
      .values({
        organizationId: orgId,
        email: email.toLowerCase(),
        displayName: displayName!,
        active: true,
      })
      .returning({ id: appUsers.id });
    const userId = insertedUsers[0]!.id;

    // Create local identity
    await tx.insert(appUserIdentities).values({
      appUserId: userId,
      provider: 'LOCAL',
      providerSubject: username.toLowerCase(),
    });

    // Hash password and store credential
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await tx.insert(localAuthCredentials).values({
      appUserId: userId,
      username: username.toLowerCase(),
      passwordHash,
    });

    // Grant SYSTEM_ADMIN role (self-granted for bootstrap)
    const adminRoles = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.code, 'SYSTEM_ADMIN'));
    if (adminRoles.length > 0) {
      await tx.insert(appUserRoles).values({
        appUserId: userId,
        roleId: adminRoles[0]!.id,
        grantedByUserId: userId,
      });
    }

    console.log(`Created local user: ${username} (${email})`);
    console.log('SYSTEM_ADMIN role granted.');
  });
} finally {
  await pool.end();
}
