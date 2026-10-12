/**
 * Building administration under Sites in the Arrise location hierarchy.
 *
 * Facilities Admins create, update, and archive Buildings. Active Buildings are
 * listed in stable code order. Archival is rejected while active Floors remain
 * and is recorded in the audit trail. Archived Sites cannot accept Buildings.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { auditEvents, buildings, floors, sites } from '../db/schema.js';

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;

export type BuildingView = {
  id: string;
  siteId: string;
  code: string;
  name: string;
};

export class BuildingError extends Error {
  constructor(
    readonly code:
      | 'invalid_building_code'
      | 'invalid_building_name'
      | 'building_code_taken'
      | 'building_not_found'
      | 'building_archived'
      | 'building_has_active_floors'
      | 'site_not_found'
      | 'site_archived',
  ) {
    super(code);
    this.name = 'BuildingError';
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

function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

function requireName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) {
    throw new BuildingError('invalid_building_name');
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

function toView(row: { id: string; siteId: string; code: string; name: string }): BuildingView {
  return {
    id: row.id,
    siteId: row.siteId,
    code: row.code,
    name: row.name,
  };
}

const buildingColumns = {
  id: buildings.id,
  siteId: buildings.siteId,
  code: buildings.code,
  name: buildings.name,
};

export class BuildingService {
  private readonly db: NodePgDatabase;

  constructor(pool: pg.Pool) {
    this.db = drizzle(pool);
  }

  async listActiveBuildings(siteId: string): Promise<BuildingView[]> {
    await this.requireActiveSite(this.db, siteId);
    const rows = await this.db
      .select(buildingColumns)
      .from(buildings)
      .where(and(eq(buildings.siteId, siteId), isNull(buildings.archivedAt)))
      .orderBy(asc(buildings.code));
    return rows.map(toView);
  }

  async createBuilding(input: {
    actorUserId: string;
    correlationId: string;
    siteId: string;
    code: string;
    name: string;
  }): Promise<BuildingView> {
    const code = normalizeCode(input.code);
    if (!CODE_PATTERN.test(code)) {
      throw new BuildingError('invalid_building_code');
    }
    const name = requireName(input.name);

    return this.db.transaction(async (tx) => {
      await this.requireActiveSite(tx, input.siteId);

      const clash = await tx
        .select({ id: buildings.id })
        .from(buildings)
        .where(and(eq(buildings.siteId, input.siteId), eq(buildings.code, code)));
      if (clash.length > 0) {
        throw new BuildingError('building_code_taken');
      }

      try {
        const inserted = await tx
          .insert(buildings)
          .values({
            siteId: input.siteId,
            code,
            name,
          })
          .returning(buildingColumns);
        return toView(inserted[0]!);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new BuildingError('building_code_taken');
        }
        throw error;
      }
    });
  }

  async updateBuilding(input: {
    actorUserId: string;
    correlationId: string;
    buildingId: string;
    name: string;
  }): Promise<BuildingView> {
    const name = requireName(input.name);

    return this.db.transaction(async (tx) => {
      const existing = await this.requireActiveBuilding(tx, input.buildingId);
      const now = new Date();
      const updated = await tx
        .update(buildings)
        .set({ name, updatedAt: now })
        .where(eq(buildings.id, existing.id))
        .returning(buildingColumns);
      return toView(updated[0]!);
    });
  }

  async archiveBuilding(input: {
    actorUserId: string;
    correlationId: string;
    buildingId: string;
  }): Promise<BuildingView> {
    return this.db.transaction(async (tx) => {
      const existing = await this.requireActiveBuilding(tx, input.buildingId);

      const activeFloors = await tx
        .select({ id: floors.id })
        .from(floors)
        .where(and(eq(floors.buildingId, existing.id), isNull(floors.archivedAt)));
      if (activeFloors.length > 0) {
        throw new BuildingError('building_has_active_floors');
      }

      const now = new Date();
      const archived = await tx
        .update(buildings)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(buildings.id, existing.id))
        .returning(buildingColumns);

      await this.writeAudit(tx, {
        actorUserId: input.actorUserId,
        action: 'building.archived',
        targetType: 'building',
        targetId: existing.id,
        correlationId: input.correlationId,
        summary: `Archived building ${existing.code}`,
      });

      return toView(archived[0]!);
    });
  }

  private async requireActiveSite(tx: NodePgDatabase, siteId: string): Promise<void> {
    const rows = await tx
      .select({ id: sites.id, archivedAt: sites.archivedAt })
      .from(sites)
      .where(eq(sites.id, siteId));
    const site = rows[0];
    if (!site) {
      throw new BuildingError('site_not_found');
    }
    if (site.archivedAt) {
      throw new BuildingError('site_archived');
    }
  }

  private async requireActiveBuilding(
    tx: NodePgDatabase,
    buildingId: string,
  ): Promise<{ id: string; code: string; siteId: string }> {
    const rows = await tx
      .select({
        id: buildings.id,
        code: buildings.code,
        siteId: buildings.siteId,
        archivedAt: buildings.archivedAt,
      })
      .from(buildings)
      .where(eq(buildings.id, buildingId));
    const building = rows[0];
    if (!building) {
      throw new BuildingError('building_not_found');
    }
    if (building.archivedAt) {
      throw new BuildingError('building_archived');
    }
    return { id: building.id, code: building.code, siteId: building.siteId };
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
