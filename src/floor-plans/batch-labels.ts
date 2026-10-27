import { createHash } from 'node:crypto';

export type OrderingStrategy = 'SELECTION' | 'ROW_MAJOR' | 'COLUMN_MAJOR';

export type BatchPlacementInput = {
  id: string;
  placementIdentityId: string;
  positionX: number;
  positionY: number;
  spatialClass: 'PHYSICAL' | 'ZONE' | 'OBSTACLE';
  currentLabel: string | null;
};

export type ProposedAssignment = {
  placementId: string;
  label: string;
};

export type LabelConflictType = 'duplicate' | 'collision' | 'ineligible_space' | 'stale_revision';

export type LabelConflict = {
  type: LabelConflictType;
  placementId?: string;
  label?: string;
  message: string;
};

export type BatchLabelConfig = {
  prefix: string;
  startNumber: number;
  width: number;
};

/**
 * Order placements according to the specified ordering strategy.
 */
export function orderPlacements(
  placements: BatchPlacementInput[],
  strategy: OrderingStrategy,
  selectionOrder?: string[],
): BatchPlacementInput[] {
  const items = [...placements];

  switch (strategy) {
    case 'SELECTION': {
      if (!selectionOrder || selectionOrder.length === 0) {
        return items;
      }
      const orderMap = new Map(selectionOrder.map((id, index) => [id, index]));
      return items.sort((a, b) => {
        const orderA = orderMap.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const orderB = orderMap.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) return orderA - orderB;
        return a.id.localeCompare(b.id);
      });
    }

    case 'ROW_MAJOR': {
      // Y ascending, then X ascending
      return items.sort((a, b) => {
        if (a.positionY !== b.positionY) {
          return a.positionY - b.positionY;
        }
        if (a.positionX !== b.positionX) {
          return a.positionX - b.positionX;
        }
        return a.id.localeCompare(b.id);
      });
    }

    case 'COLUMN_MAJOR': {
      // X ascending, then Y ascending
      return items.sort((a, b) => {
        if (a.positionX !== b.positionX) {
          return a.positionX - b.positionX;
        }
        if (a.positionY !== b.positionY) {
          return a.positionY - b.positionY;
        }
        return a.id.localeCompare(b.id);
      });
    }

    default:
      return items;
  }
}

/**
 * Deterministically generate sequential labels for ordered placements.
 */
export function generateBatchLabels(
  orderedPlacements: BatchPlacementInput[],
  config: BatchLabelConfig,
): ProposedAssignment[] {
  const { prefix, startNumber, width } = config;

  return orderedPlacements.map((placement, index) => {
    const num = startNumber + index;
    const numStr = String(num).padStart(Math.max(1, width), '0');
    return {
      placementId: placement.id,
      label: `${prefix}${numStr}`,
    };
  });
}

/**
 * Detect conflicts:
 * - ineligible_space: placement is not PHYSICAL
 * - duplicate: two proposals in the batch have the same label
 * - collision: proposal collides with an existing placement's label (not being reassigned in this batch)
 */
export function detectLabelConflicts(input: {
  selectedPlacements: BatchPlacementInput[];
  proposedAssignments: ProposedAssignment[];
  existingRevisionPlacements: BatchPlacementInput[];
}): LabelConflict[] {
  const conflicts: LabelConflict[] = [];

  // 1. Ineligible space check
  for (const placement of input.selectedPlacements) {
    if (placement.spatialClass !== 'PHYSICAL') {
      conflicts.push({
        type: 'ineligible_space',
        placementId: placement.id,
        message: `Space ${placement.id} is of class ${placement.spatialClass}. Only PHYSICAL spaces are eligible for batch labeling.`,
      });
    }
  }

  // 2. Duplicate in batch check
  const labelCounts = new Map<string, string[]>();
  for (const item of input.proposedAssignments) {
    const list = labelCounts.get(item.label) ?? [];
    list.push(item.placementId);
    labelCounts.set(item.label, list);
  }

  for (const [label, placementIds] of labelCounts.entries()) {
    if (placementIds.length > 1) {
      conflicts.push({
        type: 'duplicate',
        label,
        message: `Label "${label}" is assigned to multiple spaces in this batch: ${placementIds.join(', ')}.`,
      });
    }
  }

  // 3. Collision with unselected existing placements
  // An existing placement's label is a collision if that placement is not part of selectedPlacements
  const selectedIds = new Set(input.selectedPlacements.map((p) => p.id));
  const existingLabelsInUseByUnselected = new Map<string, string>();

  for (const existing of input.existingRevisionPlacements) {
    if (existing.currentLabel && !selectedIds.has(existing.id)) {
      existingLabelsInUseByUnselected.set(existing.currentLabel, existing.id);
    }
  }

  for (const item of input.proposedAssignments) {
    const collidingId = existingLabelsInUseByUnselected.get(item.label);
    if (collidingId) {
      conflicts.push({
        type: 'collision',
        placementId: item.placementId,
        label: item.label,
        message: `Proposed label "${item.label}" collides with existing placement ${collidingId}.`,
      });
    }
  }

  return conflicts;
}

/**
 * Deterministically compute preview token (SHA-256) over revision and canonical assignments.
 */
export function computeBatchPreviewToken(
  floorPlanRevisionId: string,
  concurrencyVersion: number,
  assignments: ProposedAssignment[],
): string {
  // Sort assignments by placementId to ensure canonical representation
  const sorted = [...assignments].sort((a, b) => a.placementId.localeCompare(b.placementId));
  const payload = JSON.stringify({
    floorPlanRevisionId,
    concurrencyVersion,
    assignments: sorted,
  });

  return createHash('sha256').update(payload).digest('hex');
}
