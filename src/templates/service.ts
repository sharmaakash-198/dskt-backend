/**
 * Element Category and Template identity for the Facilities catalog.
 *
 * Creates stable Template identities without any geometry revision. New
 * Templates are not placeable until a later ticket publishes a revision.
 */
import { and, asc, desc, eq, isNull, max } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import {
  GeometryValidationError,
  validateOrthogonalPolygon,
  type GeometryDiagnostic,
  type Vertex,
} from '../geometry/orthogonal.js';
import {
  elementCategories,
  elementTemplateRevisionVertices,
  elementTemplateRevisions,
  elementTemplates,
  organizations,
} from '../db/schema.js';

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;
const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const SPATIAL_CLASSES = ['PHYSICAL', 'ZONE', 'OBSTACLE'] as const;

export type SpatialClass = (typeof SPATIAL_CLASSES)[number];

export type CategoryView = {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  archivedAt: string | null;
};

export type TemplateView = {
  id: string;
  categoryId: string;
  code: string;
  name: string;
  description: string;
  currentRevisionId: string | null;
  placeable: boolean;
  archivedAt: string | null;
};

export type TemplateRevisionView = {
  id: string;
  templateId: string;
  revisionNumber: number;
  assignable: boolean;
  spatialClass: SpatialClass;
  borderColor: string;
  fillColor: string;
  vertices: Vertex[];
  isCurrent: boolean;
};

export class TemplateError extends Error {
  constructor(
    readonly code:
      | 'organization_missing'
      | 'invalid_category_code'
      | 'invalid_category_name'
      | 'category_code_taken'
      | 'category_not_found'
      | 'category_archived'
      | 'invalid_category_order'
      | 'invalid_template_code'
      | 'invalid_template_name'
      | 'template_code_taken'
      | 'template_not_found'
      | 'template_archived'
      | 'revision_not_found'
      | 'invalid_spatial_class'
      | 'invalid_assignability'
      | 'invalid_color'
      | 'invalid_geometry',
    readonly diagnostics: GeometryDiagnostic[] = [],
  ) {
    super(code);
    this.name = 'TemplateError';
  }
}

function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

function requireName(raw: string, error: 'invalid_category_name' | 'invalid_template_name'): string {
  const name = raw.trim();
  if (name.length === 0) {
    throw new TemplateError(error);
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

function toCategory(row: {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  archivedAt: Date | null;
}): CategoryView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    sortOrder: row.sortOrder,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}

function toTemplate(row: {
  id: string;
  categoryId: string;
  code: string;
  name: string;
  description: string;
  currentRevisionId: string | null;
  archivedAt: Date | null;
}): TemplateView {
  return {
    id: row.id,
    categoryId: row.categoryId,
    code: row.code,
    name: row.name,
    description: row.description,
    currentRevisionId: row.currentRevisionId,
    placeable: row.currentRevisionId !== null,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}

const categoryColumns = {
  id: elementCategories.id,
  code: elementCategories.code,
  name: elementCategories.name,
  sortOrder: elementCategories.sortOrder,
  archivedAt: elementCategories.archivedAt,
};

const templateColumns = {
  id: elementTemplates.id,
  categoryId: elementTemplates.categoryId,
  code: elementTemplates.code,
  name: elementTemplates.name,
  description: elementTemplates.description,
  currentRevisionId: elementTemplates.currentRevisionId,
  archivedAt: elementTemplates.archivedAt,
};

export class TemplateService {
  private readonly db: NodePgDatabase;

  constructor(pool: pg.Pool) {
    this.db = drizzle(pool);
  }

  async listCategories(): Promise<CategoryView[]> {
    const rows = await this.db
      .select(categoryColumns)
      .from(elementCategories)
      .where(isNull(elementCategories.archivedAt))
      .orderBy(asc(elementCategories.sortOrder), asc(elementCategories.code));
    return rows.map(toCategory);
  }

  async createCategory(input: { code: string; name: string }): Promise<CategoryView> {
    const code = normalizeCode(input.code);
    if (!CODE_PATTERN.test(code)) {
      throw new TemplateError('invalid_category_code');
    }
    const name = requireName(input.name, 'invalid_category_name');

    return this.db.transaction(async (tx) => {
      const orgId = await this.requireArriseOrgId(tx);

      const clash = await tx
        .select({ id: elementCategories.id })
        .from(elementCategories)
        .where(and(eq(elementCategories.organizationId, orgId), eq(elementCategories.code, code)));
      if (clash.length > 0) {
        throw new TemplateError('category_code_taken');
      }

      const maxRows = await tx
        .select({ value: max(elementCategories.sortOrder) })
        .from(elementCategories)
        .where(eq(elementCategories.organizationId, orgId));
      const nextOrder = (maxRows[0]?.value ?? -1) + 1;

      try {
        const inserted = await tx
          .insert(elementCategories)
          .values({
            organizationId: orgId,
            code,
            name,
            sortOrder: nextOrder,
          })
          .returning(categoryColumns);
        return toCategory(inserted[0]!);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new TemplateError('category_code_taken');
        }
        throw error;
      }
    });
  }

  async reorderCategories(categoryIds: string[]): Promise<CategoryView[]> {
    return this.db.transaction(async (tx) => {
      const orgId = await this.requireArriseOrgId(tx);
      const active = await tx
        .select({ id: elementCategories.id })
        .from(elementCategories)
        .where(
          and(eq(elementCategories.organizationId, orgId), isNull(elementCategories.archivedAt)),
        );

      if (categoryIds.length !== active.length) {
        throw new TemplateError('invalid_category_order');
      }
      const activeSet = new Set(active.map((row) => row.id));
      if (categoryIds.some((id) => !activeSet.has(id))) {
        throw new TemplateError('invalid_category_order');
      }
      if (new Set(categoryIds).size !== categoryIds.length) {
        throw new TemplateError('invalid_category_order');
      }

      const now = new Date();
      for (let index = 0; index < categoryIds.length; index += 1) {
        await tx
          .update(elementCategories)
          .set({ sortOrder: index, updatedAt: now })
          .where(eq(elementCategories.id, categoryIds[index]!));
      }

      const rows = await tx
        .select(categoryColumns)
        .from(elementCategories)
        .where(
          and(eq(elementCategories.organizationId, orgId), isNull(elementCategories.archivedAt)),
        )
        .orderBy(asc(elementCategories.sortOrder), asc(elementCategories.code));
      return rows.map(toCategory);
    });
  }

  async archiveCategory(categoryId: string): Promise<CategoryView> {
    return this.db.transaction(async (tx) => {
      const existing = await this.requireActiveCategory(tx, categoryId);
      const now = new Date();
      const archived = await tx
        .update(elementCategories)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(elementCategories.id, existing.id))
        .returning(categoryColumns);
      return toCategory(archived[0]!);
    });
  }

  async listTemplates(categoryId: string): Promise<TemplateView[]> {
    await this.requireActiveCategory(this.db, categoryId);
    const rows = await this.db
      .select(templateColumns)
      .from(elementTemplates)
      .where(and(eq(elementTemplates.categoryId, categoryId), isNull(elementTemplates.archivedAt)))
      .orderBy(asc(elementTemplates.code));
    return rows.map(toTemplate);
  }

  async createTemplate(input: {
    categoryId: string;
    code: string;
    name: string;
    description?: string;
  }): Promise<TemplateView> {
    const code = normalizeCode(input.code);
    if (!CODE_PATTERN.test(code)) {
      throw new TemplateError('invalid_template_code');
    }
    const name = requireName(input.name, 'invalid_template_name');
    const description = (input.description ?? '').trim();

    return this.db.transaction(async (tx) => {
      await this.requireActiveCategory(tx, input.categoryId);

      const clash = await tx
        .select({ id: elementTemplates.id })
        .from(elementTemplates)
        .where(
          and(eq(elementTemplates.categoryId, input.categoryId), eq(elementTemplates.code, code)),
        );
      if (clash.length > 0) {
        throw new TemplateError('template_code_taken');
      }

      // Identity only — never insert a revision row in this transaction.
      try {
        const inserted = await tx
          .insert(elementTemplates)
          .values({
            categoryId: input.categoryId,
            code,
            name,
            description,
          })
          .returning(templateColumns);

        const view = toTemplate(inserted[0]!);
        if (view.currentRevisionId !== null || view.placeable !== false) {
          throw new Error('template_identity_invariant_broken');
        }
        return view;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new TemplateError('template_code_taken');
        }
        throw error;
      }
    });
  }

  async listRevisions(templateId: string): Promise<TemplateRevisionView[]> {
    const template = await this.requireTemplate(this.db, templateId);
    const revisions = await this.db
      .select()
      .from(elementTemplateRevisions)
      .where(eq(elementTemplateRevisions.elementTemplateId, templateId))
      .orderBy(desc(elementTemplateRevisions.revisionNumber));

    const views: TemplateRevisionView[] = [];
    for (const revision of revisions) {
      const vertices = await this.db
        .select({
          sequence: elementTemplateRevisionVertices.sequence,
          x: elementTemplateRevisionVertices.x,
          y: elementTemplateRevisionVertices.y,
        })
        .from(elementTemplateRevisionVertices)
        .where(eq(elementTemplateRevisionVertices.elementTemplateRevisionId, revision.id))
        .orderBy(asc(elementTemplateRevisionVertices.sequence));
      views.push({
        id: revision.id,
        templateId,
        revisionNumber: revision.revisionNumber,
        assignable: revision.assignable,
        spatialClass: revision.spatialClass as SpatialClass,
        borderColor: revision.borderColor,
        fillColor: revision.fillColor,
        vertices: vertices.map((vertex) => ({ x: vertex.x, y: vertex.y })),
        isCurrent: template.currentRevisionId === revision.id,
      });
    }
    return views;
  }

  async createRevision(input: {
    actorUserId: string;
    templateId: string;
    spatialClass: string;
    assignable: boolean;
    borderColor: string;
    fillColor: string;
    vertices: Vertex[];
  }): Promise<TemplateRevisionView> {
    if (!SPATIAL_CLASSES.includes(input.spatialClass as SpatialClass)) {
      throw new TemplateError('invalid_spatial_class');
    }
    const spatialClass = input.spatialClass as SpatialClass;
    if (input.assignable && spatialClass !== 'PHYSICAL') {
      throw new TemplateError('invalid_assignability');
    }
    if (!COLOR_PATTERN.test(input.borderColor) || !COLOR_PATTERN.test(input.fillColor)) {
      throw new TemplateError('invalid_color');
    }

    let normalized: Vertex[];
    try {
      normalized = validateOrthogonalPolygon(input.vertices);
    } catch (error) {
      if (error instanceof GeometryValidationError) {
        throw new TemplateError('invalid_geometry', error.diagnostics);
      }
      throw error;
    }

    return this.db.transaction(async (tx) => {
      const template = await this.requireTemplate(tx, input.templateId);
      if (template.archivedAt) {
        throw new TemplateError('template_archived');
      }

      const maxRows = await tx
        .select({ value: max(elementTemplateRevisions.revisionNumber) })
        .from(elementTemplateRevisions)
        .where(eq(elementTemplateRevisions.elementTemplateId, input.templateId));
      const revisionNumber = (maxRows[0]?.value ?? 0) + 1;

      const inserted = await tx
        .insert(elementTemplateRevisions)
        .values({
          elementTemplateId: input.templateId,
          revisionNumber,
          assignable: input.assignable,
          spatialClass,
          borderColor: input.borderColor.toUpperCase(),
          fillColor: input.fillColor.toUpperCase(),
          createdByUserId: input.actorUserId,
        })
        .returning();
      const revision = inserted[0]!;

      await tx.insert(elementTemplateRevisionVertices).values(
        normalized.map((vertex, sequence) => ({
          elementTemplateRevisionId: revision.id,
          sequence,
          x: vertex.x,
          y: vertex.y,
        })),
      );

      // New revisions stay immutable and are not selected as current here.
      return {
        id: revision.id,
        templateId: input.templateId,
        revisionNumber,
        assignable: input.assignable,
        spatialClass,
        borderColor: revision.borderColor,
        fillColor: revision.fillColor,
        vertices: normalized,
        isCurrent: false,
      };
    });
  }

  /**
   * Selects an immutable revision as current for future placements.
   * Only updates the Template pointer; never mutates revision rows or vertices.
   */
  async activateRevision(input: {
    templateId: string;
    revisionId: string;
  }): Promise<TemplateView> {
    return this.db.transaction(async (tx) => {
      const locked = await tx
        .select(templateColumns)
        .from(elementTemplates)
        .where(eq(elementTemplates.id, input.templateId))
        .for('update');
      const template = locked[0];
      if (!template) {
        throw new TemplateError('template_not_found');
      }
      if (template.archivedAt) {
        throw new TemplateError('template_archived');
      }

      const revisionRows = await tx
        .select({
          id: elementTemplateRevisions.id,
          elementTemplateId: elementTemplateRevisions.elementTemplateId,
        })
        .from(elementTemplateRevisions)
        .where(eq(elementTemplateRevisions.id, input.revisionId));
      const revision = revisionRows[0];
      if (!revision || revision.elementTemplateId !== input.templateId) {
        throw new TemplateError('revision_not_found');
      }

      const now = new Date();
      const updated = await tx
        .update(elementTemplates)
        .set({ currentRevisionId: revision.id, updatedAt: now })
        .where(eq(elementTemplates.id, input.templateId))
        .returning(templateColumns);
      return toTemplate(updated[0]!);
    });
  }

  private async requireTemplate(
    tx: NodePgDatabase,
    templateId: string,
  ): Promise<{ id: string; currentRevisionId: string | null; archivedAt: Date | null }> {
    const rows = await tx
      .select({
        id: elementTemplates.id,
        currentRevisionId: elementTemplates.currentRevisionId,
        archivedAt: elementTemplates.archivedAt,
      })
      .from(elementTemplates)
      .where(eq(elementTemplates.id, templateId));
    const template = rows[0];
    if (!template) {
      throw new TemplateError('template_not_found');
    }
    return template;
  }

  private async requireArriseOrgId(tx: NodePgDatabase): Promise<string> {
    const orgRows = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.name, 'Arrise'));
    const orgId = orgRows[0]?.id;
    if (!orgId) {
      throw new TemplateError('organization_missing');
    }
    return orgId;
  }

  private async requireActiveCategory(
    tx: NodePgDatabase,
    categoryId: string,
  ): Promise<{ id: string; code: string }> {
    const rows = await tx
      .select({
        id: elementCategories.id,
        code: elementCategories.code,
        archivedAt: elementCategories.archivedAt,
      })
      .from(elementCategories)
      .where(eq(elementCategories.id, categoryId));
    const category = rows[0];
    if (!category) {
      throw new TemplateError('category_not_found');
    }
    if (category.archivedAt) {
      throw new TemplateError('category_archived');
    }
    return { id: category.id, code: category.code };
  }
}
