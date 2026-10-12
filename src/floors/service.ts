/**
 * Floor administration under Buildings in the Arrise location hierarchy.
 *
 * Facilities Admins create, update, and archive Floors. Active Floors are
 * listed in stable code order. Archived Buildings cannot accept Floors.
 * Archival is soft-delete only and is recorded in the audit trail.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { auditEvents, buildings, floors } from '../db/schema.js';

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;

export type FloorView = {
  id: string;
  buildingId: string;
  code: string;
  name: string;
};

export class FloorError extends Error {
  constructor(
    readonly code:
      | 'invalid_floor_code'
      | 'invalid_floor_name'
      | 'floor_code_taken'
      | 'floor_not_found'
      | 'floor_archived'
      | 'building_not_found'
      | 'building_archived',
  ) {
    super(code);
    this.name = 'FloorError';
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
    throw new FloorError('invalid_floor_name');
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

function toView(row: { id: string; buildingId: string; code: string; name: string }): FloorView {
  return {
    id: row.id,
    buildingId: row.buildingId,
    code: row.code,
    name: row.name,
  };
}

const floorColumns = {
  id: floors.id,
  buildingId: floors.buildingId,
  code: floors.code,
  name: floors.name,
};

export class FloorService {
  private readonly db: NodePgDatabase;

  constructor(pool: pg.Pool) {
    this.db = drizzle(pool);
  }

  async listActiveFloors(buildingId: string): Promise<FloorView[]> {
    await this.requireActiveBuilding(this.db, buildingId);
    const rows = await this.db
      .select(floorColumns)
      .from(floors)
      .where(and(eq(floors.buildingId, buildingId), isNull(floors.archivedAt)))
      .orderBy(asc(floors.code));
    return rows.map(toView);
  }

  async createFloor(input: {
    actorUserId: string;
    correlationId: string;
    buildingId: string;
    code: string;
    name: string;
  }): Promise<FloorView> {
    const code = normalizeCode(input.code);
    if (!CODE_PATTERN.test(code)) {
      throw new FloorError('invalid_floor_code');
    }
    const name = requireName(input.name);

    return this.db.transaction(async (tx) => {
      await this.requireActiveBuilding(tx, input.buildingId);

      const clash = await tx
        .select({ id: floors.id })
        .from(floors)
        .where(and(eq(floors.buildingId, input.buildingId), eq(floors.code, code)));
      if (clash.length > 0) {
        throw new FloorError('floor_code_taken');
      }

      try {
        const inserted = await tx
          .insert(floors)
          .values({
            buildingId: input.buildingId,
            code,
            name,
          })
          .returning(floorColumns);
        return toView(inserted[0]!);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new FloorError('floor_code_taken');
        }
        throw error;
      }
    });
  }

  async updateFloor(input: {
    actorUserId: string;
    correlationId: string;
    floorId: string;
    name: string;
  }): Promise<FloorView> {
    const name = requireName(input.name);

    return this.db.transaction(async (tx) => {
      const existing = await this.requireActiveFloor(tx, input.floorId);
      const now = new Date();
      const updated = await tx
        .update(floors)
        .set({ name, updatedAt: now })
        .where(eq(floors.id, existing.id))
        .returning(floorColumns);
      return toView(updated[0]!);
    });
  }

  async archiveFloor(input: {
    actorUserId: string;
    correlationId: string;
    floorId: string;
  }): Promise<FloorView> {
    return this.db.transaction(async (tx) => {
      const existing = await this.requireActiveFloor(tx, input.floorId);
      const now = new Date();
      const archived = await tx
        .update(floors)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(floors.id, existing.id))
        .returning(floorColumns);

      await this.writeAudit(tx, {
        actorUserId: input.actorUserId,
        action: 'floor.archived',
        targetType: 'floor',
        targetId: existing.id,
        correlationId: input.correlationId,
        summary: `Archived floor ${existing.code}`,
      });

      return toView(archived[0]!);
    });
  }

  private async requireActiveBuilding(tx: NodePgDatabase, buildingId: string): Promise<void> {
    const rows = await tx
      .select({ id: buildings.id, archivedAt: buildings.archivedAt })
      .from(buildings)
      .where(eq(buildings.id, buildingId));
    const building = rows[0];
    if (!building) {
      throw new FloorError('building_not_found');
    }
    if (building.archivedAt) {
      throw new FloorError('building_archived');
    }
  }

  private async requireActiveFloor(
    tx: NodePgDatabase,
    floorId: string,
  ): Promise<{ id: string; code: string; buildingId: string }> {
    const rows = await tx
      .select({
        id: floors.id,
        code: floors.code,
        buildingId: floors.buildingId,
        archivedAt: floors.archivedAt,
      })
      .from(floors)
      .where(eq(floors.id, floorId));
    const floor = rows[0];
    if (!floor) {
      throw new FloorError('floor_not_found');
    }
    if (floor.archivedAt) {
      throw new FloorError('floor_archived');
    }
    return { id: floor.id, code: floor.code, buildingId: floor.buildingId };
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
