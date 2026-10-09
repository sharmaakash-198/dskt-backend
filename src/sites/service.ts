/**
 * Site administration for the Arrise location hierarchy.
 *
 * Facilities Admins create, update, and archive Sites. Active Sites are listed
 * in stable code order. Archival is rejected while active Buildings remain and
 * is recorded in the audit trail.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { auditEvents, buildings, organizations, sites } from '../db/schema.js';

const SITE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;

export type SiteAddress = {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
};

export type SiteView = {
  id: string;
  code: string;
  name: string;
  timeZone: string;
  address: SiteAddress;
};

export type SiteWriteInput = {
  name: string;
  timeZone: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
};

export class SiteError extends Error {
  constructor(
    readonly code:
      | 'organization_missing'
      | 'invalid_site_code'
      | 'invalid_site_name'
      | 'invalid_time_zone'
      | 'site_code_taken'
      | 'site_not_found'
      | 'site_archived'
      | 'site_has_active_buildings',
  ) {
    super(code);
    this.name = 'SiteError';
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

function isValidTimeZone(value: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

function optionalText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function requireName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) {
    throw new SiteError('invalid_site_name');
  }
  return name;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: string }).code === '23505'
  );
}

function toView(row: {
  id: string;
  code: string;
  name: string;
  timeZone: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
}): SiteView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    timeZone: row.timeZone,
    address: {
      addressLine1: row.addressLine1,
      addressLine2: row.addressLine2,
      city: row.city,
      region: row.region,
      postalCode: row.postalCode,
      country: row.country,
    },
  };
}

const siteColumns = {
  id: sites.id,
  code: sites.code,
  name: sites.name,
  timeZone: sites.timeZone,
  addressLine1: sites.addressLine1,
  addressLine2: sites.addressLine2,
  city: sites.city,
  region: sites.region,
  postalCode: sites.postalCode,
  country: sites.country,
};

export class SiteService {
  private readonly db: NodePgDatabase;

  constructor(pool: pg.Pool) {
    this.db = drizzle(pool);
  }

  async listActiveSites(): Promise<SiteView[]> {
    const rows = await this.db
      .select(siteColumns)
      .from(sites)
      .where(isNull(sites.archivedAt))
      .orderBy(asc(sites.code));
    return rows.map(toView);
  }

  async createSite(input: {
    actorUserId: string;
    correlationId: string;
    code: string;
  } & SiteWriteInput): Promise<SiteView> {
    const code = normalizeCode(input.code);
    if (!SITE_CODE_PATTERN.test(code)) {
      throw new SiteError('invalid_site_code');
    }
    if (!isValidTimeZone(input.timeZone)) {
      throw new SiteError('invalid_time_zone');
    }
    const name = requireName(input.name);

    return this.db.transaction(async (tx) => {
      const orgId = await this.requireArriseOrgId(tx);

      const clash = await tx
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.organizationId, orgId), eq(sites.code, code)));
      if (clash.length > 0) {
        throw new SiteError('site_code_taken');
      }

      try {
        const inserted = await tx
          .insert(sites)
          .values({
            organizationId: orgId,
            code,
            name,
            timeZone: input.timeZone,
            addressLine1: optionalText(input.addressLine1),
            addressLine2: optionalText(input.addressLine2),
            city: optionalText(input.city),
            region: optionalText(input.region),
            postalCode: optionalText(input.postalCode),
            country: optionalText(input.country),
          })
          .returning(siteColumns);

        return toView(inserted[0]!);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new SiteError('site_code_taken');
        }
        throw error;
      }
    });
  }

  async updateSite(input: {
    actorUserId: string;
    correlationId: string;
    siteId: string;
  } & SiteWriteInput): Promise<SiteView> {
    if (!isValidTimeZone(input.timeZone)) {
      throw new SiteError('invalid_time_zone');
    }
    const name = requireName(input.name);

    return this.db.transaction(async (tx) => {
      const existing = await this.requireActiveSite(tx, input.siteId);
      const now = new Date();
      const patch: {
        name: string;
        timeZone: string;
        updatedAt: Date;
        addressLine1?: string | null;
        addressLine2?: string | null;
        city?: string | null;
        region?: string | null;
        postalCode?: string | null;
        country?: string | null;
      } = {
        name,
        timeZone: input.timeZone,
        updatedAt: now,
      };
      if (input.addressLine1 !== undefined) {
        patch.addressLine1 = optionalText(input.addressLine1);
      }
      if (input.addressLine2 !== undefined) {
        patch.addressLine2 = optionalText(input.addressLine2);
      }
      if (input.city !== undefined) {
        patch.city = optionalText(input.city);
      }
      if (input.region !== undefined) {
        patch.region = optionalText(input.region);
      }
      if (input.postalCode !== undefined) {
        patch.postalCode = optionalText(input.postalCode);
      }
      if (input.country !== undefined) {
        patch.country = optionalText(input.country);
      }

      const updated = await tx
        .update(sites)
        .set(patch)
        .where(eq(sites.id, existing.id))
        .returning(siteColumns);
      return toView(updated[0]!);
    });
  }

  async archiveSite(input: {
    actorUserId: string;
    correlationId: string;
    siteId: string;
  }): Promise<SiteView> {
    return this.db.transaction(async (tx) => {
      const existing = await this.requireActiveSite(tx, input.siteId);

      const activeBuildings = await tx
        .select({ id: buildings.id })
        .from(buildings)
        .where(and(eq(buildings.siteId, existing.id), isNull(buildings.archivedAt)));
      if (activeBuildings.length > 0) {
        throw new SiteError('site_has_active_buildings');
      }

      const now = new Date();
      const archived = await tx
        .update(sites)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(sites.id, existing.id))
        .returning(siteColumns);

      await this.writeAudit(tx, {
        actorUserId: input.actorUserId,
        action: 'site.archived',
        targetType: 'site',
        targetId: existing.id,
        correlationId: input.correlationId,
        summary: `Archived site ${existing.code}`,
      });

      return toView(archived[0]!);
    });
  }

  private async requireArriseOrgId(tx: NodePgDatabase): Promise<string> {
    const orgRows = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.name, 'Arrise'));
    const orgId = orgRows[0]?.id;
    if (!orgId) {
      throw new SiteError('organization_missing');
    }
    return orgId;
  }

  private async requireActiveSite(
    tx: NodePgDatabase,
    siteId: string,
  ): Promise<{ id: string; code: string }> {
    const rows = await tx
      .select({ id: sites.id, code: sites.code, archivedAt: sites.archivedAt })
      .from(sites)
      .where(eq(sites.id, siteId));
    const site = rows[0];
    if (!site) {
      throw new SiteError('site_not_found');
    }
    if (site.archivedAt) {
      throw new SiteError('site_archived');
    }
    return { id: site.id, code: site.code };
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
