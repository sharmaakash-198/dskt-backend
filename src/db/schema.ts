import { sql } from 'drizzle-orm';
import {
  pgSchema,
  uuid,
  text,
  boolean,
  smallint,
  integer,
  timestamp,
  unique,
  primaryKey,
  uniqueIndex,
  index,
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
    currentRevisionId: uuid('current_revision_id'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('element_templates_category_id_code_unique').on(table.categoryId, table.code),
  ],
);

export const elementTemplateRevisions = dskt.table(
  'element_template_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    elementTemplateId: uuid('element_template_id')
      .notNull()
      .references(() => elementTemplates.id),
    revisionNumber: integer('revision_number').notNull(),
    assignable: boolean('assignable').notNull(),
    spatialClass: text('spatial_class').notNull(),
    borderColor: text('border_color').notNull(),
    fillColor: text('fill_color').notNull(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('element_template_revisions_template_id_revision_number_unique').on(
      table.elementTemplateId,
      table.revisionNumber,
    ),
  ],
);

export const elementTemplateRevisionVertices = dskt.table(
  'element_template_revision_vertices',
  {
    elementTemplateRevisionId: uuid('element_template_revision_id')
      .notNull()
      .references(() => elementTemplateRevisions.id),
    sequence: integer('sequence').notNull(),
    x: integer('x').notNull(),
    y: integer('y').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'element_template_revision_vertices_pk',
      columns: [table.elementTemplateRevisionId, table.sequence],
    }),
    unique('element_template_revision_vertices_xy_unique').on(
      table.elementTemplateRevisionId,
      table.x,
      table.y,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Floor Plans and Revisions
// ---------------------------------------------------------------------------

export const floorPlans = dskt.table(
  'floor_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    floorId: uuid('floor_id')
      .notNull()
      .references(() => floors.id),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('floor_plans_floor_id_unique').on(table.floorId)],
);

export const floorPlanRevisions = dskt.table(
  'floor_plan_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    floorPlanId: uuid('floor_plan_id')
      .notNull()
      .references(() => floorPlans.id),
    revisionNumber: integer('revision_number').notNull(),
    lifecycleState: text('lifecycle_state').notNull(),
    editingScale: integer('editing_scale').notNull(),
    concurrencyVersion: integer('concurrency_version').notNull().default(0),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => appUsers.id),
    publishedByUserId: uuid('published_by_user_id').references(() => appUsers.id),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('floor_plan_revisions_plan_id_revision_number_unique').on(
      table.floorPlanId,
      table.revisionNumber,
    ),
    uniqueIndex('floor_plan_revisions_one_draft_idx')
      .on(table.floorPlanId)
      .where(sql`lifecycle_state = 'DRAFT'`),
    uniqueIndex('floor_plan_revisions_one_published_idx')
      .on(table.floorPlanId)
      .where(sql`lifecycle_state = 'PUBLISHED'`),
  ],
);

export const floorPlanRevisionBoundaryVertices = dskt.table(
  'floor_plan_revision_boundary_vertices',
  {
    floorPlanRevisionId: uuid('floor_plan_revision_id')
      .notNull()
      .references(() => floorPlanRevisions.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    x: integer('x').notNull(),
    y: integer('y').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'floor_plan_revision_boundary_vertices_pk',
      columns: [table.floorPlanRevisionId, table.sequence],
    }),
    unique('floor_plan_revision_boundary_vertices_xy_unique').on(
      table.floorPlanRevisionId,
      table.x,
      table.y,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Placements and Placed Elements
// ---------------------------------------------------------------------------

export const placementIdentities = dskt.table('placement_identities', {
  id: uuid('id').primaryKey().defaultRandom(),
  floorPlanId: uuid('floor_plan_id')
    .notNull()
    .references(() => floorPlans.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const placedElements = dskt.table(
  'placed_elements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    floorPlanRevisionId: uuid('floor_plan_revision_id')
      .notNull()
      .references(() => floorPlanRevisions.id, { onDelete: 'cascade' }),
    placementIdentityId: uuid('placement_identity_id')
      .notNull()
      .references(() => placementIdentities.id, { onDelete: 'cascade' }),
    elementTemplateRevisionId: uuid('element_template_revision_id')
      .notNull()
      .references(() => elementTemplateRevisions.id),
    positionX: integer('position_x').notNull(),
    positionY: integer('position_y').notNull(),
    rotationDegrees: integer('rotation_degrees').notNull(),
    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('placed_elements_revision_placement_identity_unique').on(
      table.floorPlanRevisionId,
      table.placementIdentityId,
    ),
    uniqueIndex('placed_elements_revision_label_unique')
      .on(table.floorPlanRevisionId, table.label)
      .where(sql`label IS NOT NULL`),
  ],
);

export const floorPlanEditorLeases = dskt.table(
  'floor_plan_editor_leases',
  {
    floorPlanRevisionId: uuid('floor_plan_revision_id')
      .primaryKey()
      .references(() => floorPlanRevisions.id, { onDelete: 'cascade' }),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUsers.id),
    leaseTokenHash: text('lease_token_hash').notNull(),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    renewedAt: timestamp('renewed_at', { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  (table) => [
    index('floor_plan_editor_leases_app_user_idx').on(table.appUserId),
  ],
);

export const processedCommands = dskt.table(
  'processed_commands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    floorPlanRevisionId: uuid('floor_plan_revision_id')
      .notNull()
      .references(() => floorPlanRevisions.id, { onDelete: 'cascade' }),
    clientCommandId: text('client_command_id').notNull(),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUsers.id),
    commandType: text('command_type').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: text('response_body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('processed_commands_revision_cmd_uidx').on(
      table.floorPlanRevisionId,
      table.clientCommandId,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Workforce & Employee Imports
// ---------------------------------------------------------------------------

export const departments = dskt.table('departments', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const teams = dskt.table('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  departmentId: uuid('department_id').references(() => departments.id),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const employeeImports = dskt.table(
  'employee_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    uploadedByUserId: uuid('uploaded_by_user_id')
      .notNull()
      .references(() => appUsers.id),
    originalFilename: text('original_filename').notNull(),
    fileSha256: text('file_sha256').notNull(),
    status: text('status').notNull(),
    totalRows: integer('total_rows').notNull().default(0),
    validRows: integer('valid_rows').notNull().default(0),
    invalidRows: integer('invalid_rows').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    idempotencyKey: text('idempotency_key'),
  },
  (table) => [
    index('employee_imports_file_sha256_idx').on(table.fileSha256),
    index('employee_imports_uploaded_by_idx').on(table.uploadedByUserId),
    index('employee_imports_idempotency_key_idx').on(table.idempotencyKey),
  ],
);

export const employees = dskt.table(
  'employees',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: text('employee_id').notNull().unique(),
    fullName: text('full_name').notNull(),
    email: text('email').unique(),
    managerEmployeeId: text('manager_employee_id'),
    teamId: uuid('team_id').references(() => teams.id),
    departmentId: uuid('department_id').references(() => departments.id),
    preferredSiteId: uuid('preferred_site_id').references(() => sites.id),
    jobTitle: text('job_title'),
    employmentStatus: text('employment_status').notNull(),
    active: boolean('active').notNull().default(true),
    lastImportId: uuid('last_import_id').references(() => employeeImports.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('employees_employee_id_idx').on(table.employeeId),
    index('employees_email_idx').on(table.email),
    index('employees_team_id_idx').on(table.teamId),
    index('employees_department_id_idx').on(table.departmentId),
  ],
);

export const employeeImportRows = dskt.table(
  'employee_import_rows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeImportId: uuid('employee_import_id')
      .notNull()
      .references(() => employeeImports.id, { onDelete: 'cascade' }),
    rowNumber: integer('row_number').notNull(),
    action: text('action').notNull(),
    isValid: boolean('is_valid').notNull().default(true),
    employeeId: text('employee_id'),
    fullName: text('full_name'),
    email: text('email'),
    employmentStatus: text('employment_status'),
    managerEmployeeId: text('manager_employee_id'),
    teamCode: text('team_code'),
    teamName: text('team_name'),
    departmentCode: text('department_code'),
    departmentName: text('department_name'),
    preferredSiteCode: text('preferred_site_code'),
    jobTitle: text('job_title'),
    active: boolean('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('employee_import_rows_import_row_unique').on(table.employeeImportId, table.rowNumber),
    index('employee_import_rows_import_idx').on(table.employeeImportId),
    index('employee_import_rows_action_idx').on(table.employeeImportId, table.action),
  ],
);

export const employeeImportRowErrors = dskt.table(
  'employee_import_row_errors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeImportRowId: uuid('employee_import_row_id')
      .notNull()
      .references(() => employeeImportRows.id, { onDelete: 'cascade' }),
    columnName: text('column_name'),
    errorCode: text('error_code').notNull(),
    message: text('message').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('employee_import_row_errors_row_idx').on(table.employeeImportRowId),
  ],
);

// ---------------------------------------------------------------------------
// Space Assignments
// ---------------------------------------------------------------------------

export const assignments = dskt.table(
  'assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    placementIdentityId: uuid('placement_identity_id')
      .notNull()
      .references(() => placementIdentities.id),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    assignedByUserId: uuid('assigned_by_user_id')
      .notNull()
      .references(() => appUsers.id),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    clientCommandId: text('client_command_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('assignments_employee_id_idx').on(table.employeeId),
    index('assignments_placement_identity_idx').on(table.placementIdentityId),
    uniqueIndex('assignments_client_command_id_uidx').on(table.clientCommandId),
  ],
);

