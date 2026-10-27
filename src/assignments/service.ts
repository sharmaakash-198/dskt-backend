import { and, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  assignments,
  auditEvents,
  buildings,
  departments,
  elementTemplateRevisions,
  employees,
  floorPlanRevisions,
  floorPlans,
  floors,
  placedElements,
  placementIdentities,
  sites,
} from '../db/schema.js';
import {
  AssignmentError,
  type AssignmentView,
  type CreateAssignmentInput,
  type QueryAssignmentsFilter,
} from './types.js';

export class AssignmentService {
  private db: ReturnType<typeof drizzle>;

  constructor(pool: pg.Pool) {
    this.db = drizzle(pool);
  }

  /**
   * Create a time-bounded space assignment for an employee to an assignable space in a published floor plan revision.
   */
  async createAssignment(input: CreateAssignmentInput): Promise<AssignmentView> {
    // 1. Validate dates
    const startDate = new Date(input.startedAt);
    if (isNaN(startDate.getTime())) {
      throw new AssignmentError('invalid_assignment_period', 'Invalid startedAt timestamp');
    }

    let endDate: Date | null = null;
    if (input.endedAt) {
      endDate = new Date(input.endedAt);
      if (isNaN(endDate.getTime())) {
        throw new AssignmentError('invalid_assignment_period', 'Invalid endedAt timestamp');
      }
      if (endDate.getTime() <= startDate.getTime()) {
        throw new AssignmentError(
          'invalid_assignment_period',
          'Assignment end time must be later than start time',
        );
      }
    }

    return await this.db.transaction(async (tx) => {
      // 2. Idempotency check via clientCommandId
      if (input.clientCommandId) {
        const existingCmd = await tx
          .select()
          .from(assignments)
          .where(eq(assignments.clientCommandId, input.clientCommandId));

        if (existingCmd.length > 0) {
          const match = existingCmd[0]!;
          const matchStart = new Date(match.startedAt).getTime();
          const matchEnd = match.endedAt ? new Date(match.endedAt).getTime() : null;
          const reqEnd = endDate ? endDate.getTime() : null;

          const samePayload =
            match.employeeId === input.employeeId &&
            match.placementIdentityId === input.placementIdentityId &&
            matchStart === startDate.getTime() &&
            matchEnd === reqEnd;

          if (!samePayload) {
            throw new AssignmentError(
              'command_id_payload_mismatch',
              'An assignment with this clientCommandId already exists with different parameters',
            );
          }

          const existingView = await this.fetchAssignmentViewById(tx, match.id);
          if (existingView) return existingView;
        }
      }

      // 3. Verify employee exists and is active
      const empRows = await tx
        .select()
        .from(employees)
        .where(eq(employees.id, input.employeeId));

      const emp = empRows[0];
      if (!emp) {
        throw new AssignmentError('employee_not_found', 'Employee does not exist');
      }
      if (!emp.active) {
        throw new AssignmentError('employee_inactive', 'Cannot assign an inactive employee');
      }

      // 4. Verify placement identity and location hierarchy
      const placementRows = await tx
        .select({
          placementIdentityId: placementIdentities.id,
          floorPlanId: floorPlans.id,
          floorId: floors.id,
          floorName: floors.name,
          floorArchivedAt: floors.archivedAt,
          buildingName: buildings.name,
          buildingArchivedAt: buildings.archivedAt,
          siteName: sites.name,
          siteArchivedAt: sites.archivedAt,
        })
        .from(placementIdentities)
        .innerJoin(floorPlans, eq(floorPlans.id, placementIdentities.floorPlanId))
        .innerJoin(floors, eq(floors.id, floorPlans.floorId))
        .innerJoin(buildings, eq(buildings.id, floors.buildingId))
        .innerJoin(sites, eq(sites.id, buildings.siteId))
        .where(eq(placementIdentities.id, input.placementIdentityId));

      const location = placementRows[0];
      if (!location) {
        throw new AssignmentError('space_not_found', 'Placement identity not found');
      }

      if (location.floorArchivedAt || location.buildingArchivedAt || location.siteArchivedAt) {
        throw new AssignmentError(
          'location_archived',
          'Cannot assign spaces in an archived site, building, or floor',
        );
      }

      // 5. Verify published revision
      const revRows = await tx
        .select()
        .from(floorPlanRevisions)
        .where(
          and(
            eq(floorPlanRevisions.floorPlanId, location.floorPlanId),
            eq(floorPlanRevisions.lifecycleState, 'PUBLISHED'),
          ),
        );

      const publishedRev = revRows[0];
      if (!publishedRev) {
        throw new AssignmentError(
          'revision_not_published',
          'Floor plan does not have an active Published revision',
        );
      }

      // 6. Verify placed element in the published revision and assignability
      const placedRows = await tx
        .select({
          placedElementId: placedElements.id,
          label: placedElements.label,
          assignable: elementTemplateRevisions.assignable,
          spatialClass: elementTemplateRevisions.spatialClass,
        })
        .from(placedElements)
        .innerJoin(
          elementTemplateRevisions,
          eq(elementTemplateRevisions.id, placedElements.elementTemplateRevisionId),
        )
        .where(
          and(
            eq(placedElements.floorPlanRevisionId, publishedRev.id),
            eq(placedElements.placementIdentityId, input.placementIdentityId),
          ),
        );

      const placedSpace = placedRows[0];
      if (!placedSpace) {
        throw new AssignmentError(
          'space_not_found',
          'Candidate space does not exist in the active Published revision',
        );
      }

      if (!placedSpace.assignable || placedSpace.spatialClass !== 'PHYSICAL') {
        throw new AssignmentError(
          'space_not_assignable',
          'Selected space is not assignable or not of class PHYSICAL',
        );
      }

      // 7. Domain logic check: overlapping periods for this placement identity
      // Boundary-touching ([start, end) and [end, later)) is permitted and does not overlap.
      const overlapQuery = await tx.execute(sql`
        SELECT id, started_at, ended_at
        FROM dskt.assignments
        WHERE placement_identity_id = ${input.placementIdentityId}
          AND started_at < COALESCE(${endDate ? endDate.toISOString() : null}::timestamptz, 'infinity'::timestamptz)
          AND COALESCE(ended_at, 'infinity'::timestamptz) > ${startDate.toISOString()}::timestamptz
        LIMIT 1
      `);

      if (overlapQuery.rows.length > 0) {
        throw new AssignmentError(
          'space_already_assigned',
          'Candidate space is already assigned for an overlapping time period',
        );
      }

      // 8. Insert assignment into database
      let newAssignmentId: string;
      try {
        const inserted = await tx
          .insert(assignments)
          .values({
            placementIdentityId: input.placementIdentityId,
            employeeId: input.employeeId,
            assignedByUserId: input.actorUserId,
            startedAt: startDate,
            endedAt: endDate,
            clientCommandId: input.clientCommandId || null,
          })
          .returning({ id: assignments.id });

        newAssignmentId = inserted[0]!.id;
      } catch (err: unknown) {
        // PostgreSQL code 23P01 is exclusion_violation
        if (
          err &&
          typeof err === 'object' &&
          'code' in err &&
          (err as { code: string }).code === '23P01'
        ) {
          throw new AssignmentError(
            'space_already_assigned',
            'Candidate space is already assigned for an overlapping time period',
          );
        }
        throw err;
      }

      // 9. Audit log event
      const correlationId = input.clientCommandId || randomUUID();
      const endText = endDate ? ` to ${endDate.toISOString()}` : ' (ongoing)';
      await tx.insert(auditEvents).values({
        actorUserId: input.actorUserId,
        action: 'assignment.created',
        targetType: 'assignment',
        targetId: newAssignmentId,
        correlationId,
        summary: `Assigned employee ${emp.fullName} (${emp.employeeId}) to space ${placedSpace.label ?? 'unlabeled'} on floor ${location.floorName} from ${startDate.toISOString()}${endText}`,
      });

      // 10. Fetch and return created view
      const view = await this.fetchAssignmentViewById(tx, newAssignmentId);
      if (!view) {
        throw new Error('Failed to retrieve newly created assignment');
      }
      return view;
    });
  }

  /**
   * Query assignments filtered by employeeId, placementIdentityId, or floorId.
   */
  async getAssignments(filter: QueryAssignmentsFilter): Promise<AssignmentView[]> {
    const conditions = [];

    if (filter.employeeId) {
      conditions.push(eq(assignments.employeeId, filter.employeeId));
    }

    if (filter.placementIdentityId) {
      conditions.push(eq(assignments.placementIdentityId, filter.placementIdentityId));
    }

    if (filter.floorId) {
      conditions.push(eq(floors.id, filter.floorId));
    }

    const query = this.db
      .select({
        id: assignments.id,
        placementIdentityId: assignments.placementIdentityId,
        employeeId: assignments.employeeId,
        employeeName: employees.fullName,
        employeeCode: employees.employeeId,
        employeeEmail: employees.email,
        departmentName: departments.name,
        startedAt: assignments.startedAt,
        endedAt: assignments.endedAt,
        assignedByUserId: assignments.assignedByUserId,
        clientCommandId: assignments.clientCommandId,
        createdAt: assignments.createdAt,
        floorId: floors.id,
        floorName: floors.name,
        buildingName: buildings.name,
        siteName: sites.name,
      })
      .from(assignments)
      .innerJoin(employees, eq(employees.id, assignments.employeeId))
      .leftJoin(departments, eq(departments.id, employees.departmentId))
      .innerJoin(placementIdentities, eq(placementIdentities.id, assignments.placementIdentityId))
      .innerJoin(floorPlans, eq(floorPlans.id, placementIdentities.floorPlanId))
      .innerJoin(floors, eq(floors.id, floorPlans.floorId))
      .innerJoin(buildings, eq(buildings.id, floors.buildingId))
      .innerJoin(sites, eq(sites.id, buildings.siteId))
      .orderBy(desc(assignments.startedAt));

    if (conditions.length > 0) {
      query.where(and(...conditions));
    }

    const rows = await query;

    // Resolve space labels from active published revision where available
    const placementIds = Array.from(new Set(rows.map((r) => r.placementIdentityId)));
    const labelsByPlacementId = new Map<string, string | null>();

    if (placementIds.length > 0) {
      const placedRows = await this.db
        .select({
          placementIdentityId: placedElements.placementIdentityId,
          label: placedElements.label,
        })
        .from(placedElements)
        .innerJoin(
          floorPlanRevisions,
          eq(floorPlanRevisions.id, placedElements.floorPlanRevisionId),
        )
        .where(
          and(
            eq(floorPlanRevisions.lifecycleState, 'PUBLISHED'),
            sql`${placedElements.placementIdentityId} IN ${placementIds}`,
          ),
        );

      for (const p of placedRows) {
        labelsByPlacementId.set(p.placementIdentityId, p.label);
      }
    }

    return rows.map((r) => ({
      id: r.id,
      placementIdentityId: r.placementIdentityId,
      employeeId: r.employeeId,
      employeeName: r.employeeName,
      employeeCode: r.employeeCode,
      employeeEmail: r.employeeEmail,
      departmentName: r.departmentName,
      spaceLabel: labelsByPlacementId.get(r.placementIdentityId) ?? null,
      floorId: r.floorId,
      floorName: r.floorName,
      buildingName: r.buildingName,
      siteName: r.siteName,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt ? r.endedAt.toISOString() : null,
      assignedByUserId: r.assignedByUserId,
      clientCommandId: r.clientCommandId,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * Helper to retrieve a single assignment view by ID within a transaction or standalone.
   */
  private async fetchAssignmentViewById(
    txOrDb: ReturnType<typeof drizzle> | Parameters<Parameters<ReturnType<typeof drizzle>['transaction']>[0]>[0],
    assignmentId: string,
  ): Promise<AssignmentView | null> {
    const rows = await txOrDb
      .select({
        id: assignments.id,
        placementIdentityId: assignments.placementIdentityId,
        employeeId: assignments.employeeId,
        employeeName: employees.fullName,
        employeeCode: employees.employeeId,
        employeeEmail: employees.email,
        departmentName: departments.name,
        startedAt: assignments.startedAt,
        endedAt: assignments.endedAt,
        assignedByUserId: assignments.assignedByUserId,
        clientCommandId: assignments.clientCommandId,
        createdAt: assignments.createdAt,
        floorId: floors.id,
        floorName: floors.name,
        buildingName: buildings.name,
        siteName: sites.name,
      })
      .from(assignments)
      .innerJoin(employees, eq(employees.id, assignments.employeeId))
      .leftJoin(departments, eq(departments.id, employees.departmentId))
      .innerJoin(placementIdentities, eq(placementIdentities.id, assignments.placementIdentityId))
      .innerJoin(floorPlans, eq(floorPlans.id, placementIdentities.floorPlanId))
      .innerJoin(floors, eq(floors.id, floorPlans.floorId))
      .innerJoin(buildings, eq(buildings.id, floors.buildingId))
      .innerJoin(sites, eq(sites.id, buildings.siteId))
      .where(eq(assignments.id, assignmentId));

    const r = rows[0];
    if (!r) return null;

    // Resolve space label from published revision
    const placed = await txOrDb
      .select({ label: placedElements.label })
      .from(placedElements)
      .innerJoin(
        floorPlanRevisions,
        eq(floorPlanRevisions.id, placedElements.floorPlanRevisionId),
      )
      .where(
        and(
          eq(floorPlanRevisions.lifecycleState, 'PUBLISHED'),
          eq(placedElements.placementIdentityId, r.placementIdentityId),
        ),
      );

    return {
      id: r.id,
      placementIdentityId: r.placementIdentityId,
      employeeId: r.employeeId,
      employeeName: r.employeeName,
      employeeCode: r.employeeCode,
      employeeEmail: r.employeeEmail,
      departmentName: r.departmentName,
      spaceLabel: placed[0]?.label ?? null,
      floorId: r.floorId,
      floorName: r.floorName,
      buildingName: r.buildingName,
      siteName: r.siteName,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt ? r.endedAt.toISOString() : null,
      assignedByUserId: r.assignedByUserId,
      clientCommandId: r.clientCommandId,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
