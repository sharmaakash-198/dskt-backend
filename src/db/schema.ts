import {
  pgSchema,
  uuid,
  text,
  boolean,
  smallint,
  integer,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

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

// ---------------------------------------------------------------------------
// Access administration support
// ---------------------------------------------------------------------------

export const auditEvents = dskt.table('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  actorUserId: uuid('actor_user_id')
    .notNull()
    .references(() => appUsers.id),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  correlationId: text('correlation_id').notNull(),
  summary: text('summary').notNull(),
});

/** Temporary lease rows until Floor Plan editor leases land. */
export const editorLeases = dskt.table('editor_leases', {
  id: uuid('id').primaryKey().defaultRandom(),
  appUserId: uuid('app_user_id')
    .notNull()
    .references(() => appUsers.id),
  resourceKey: text('resource_key').notNull(),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  reclaimableAt: timestamp('reclaimable_at', { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// Location hierarchy
// ---------------------------------------------------------------------------

export const sites = dskt.table(
  'sites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    timeZone: text('time_zone').notNull(),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    region: text('region'),
    postalCode: text('postal_code'),
    country: text('country'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('sites_organization_id_code_unique').on(table.organizationId, table.code)],
);

export const buildings = dskt.table(
  'buildings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('buildings_site_id_code_unique').on(table.siteId, table.code)],
);

export const floors = dskt.table(
  'floors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    buildingId: uuid('building_id')
      .notNull()
      .references(() => buildings.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('floors_building_id_code_unique').on(table.buildingId, table.code)],
);

// ---------------------------------------------------------------------------
// Element template catalog (identity only; revisions come later)
// ---------------------------------------------------------------------------

export const elementCategories = dskt.table(
  'element_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('element_categories_organization_id_code_unique').on(table.organizationId, table.code),
  ],
);

export const elementTemplates = dskt.table(
  'element_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => elementCategories.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('element_templates_category_id_code_unique').on(table.categoryId, table.code),
  ],
);
