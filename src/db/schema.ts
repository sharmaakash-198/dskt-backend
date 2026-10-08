import { pgSchema, uuid, text, boolean, smallint, timestamp } from 'drizzle-orm/pg-core';

export const dskt = pgSchema('dskt');

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

export const organizations = dskt.table('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// Application users
// ---------------------------------------------------------------------------

export const appUsers = dskt.table('app_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  active: boolean('active').notNull().default(true),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const appUserIdentities = dskt.table('app_user_identities', {
  id: uuid('id').primaryKey().defaultRandom(),
  appUserId: uuid('app_user_id')
    .notNull()
    .references(() => appUsers.id),
  provider: text('provider').notNull(),
  providerSubject: text('provider_subject').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Local auth (development only)
// ---------------------------------------------------------------------------

export const localAuthCredentials = dskt.table('local_auth_credentials', {
  appUserId: uuid('app_user_id')
    .primaryKey()
    .references(() => appUsers.id),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
});

export const localAuthSessions = dskt.table('local_auth_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  appUserId: uuid('app_user_id')
    .notNull()
    .references(() => appUsers.id),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const roles = dskt.table('roles', {
  id: smallint('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
});

export const appUserRoles = dskt.table('app_user_roles', {
  appUserId: uuid('app_user_id')
    .notNull()
    .references(() => appUsers.id),
  roleId: smallint('role_id')
    .notNull()
    .references(() => roles.id),
  grantedByUserId: uuid('granted_by_user_id')
    .notNull()
    .references(() => appUsers.id),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});
