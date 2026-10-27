import { describe, expect, it } from 'vitest';
import {
  generateBatchLabels,
  orderPlacements,
  detectLabelConflicts,
  computeBatchPreviewToken,
  type BatchPlacementInput,
} from '../src/floor-plans/batch-labels.js';

describe('Batch labeling domain logic', () => {
  const samplePlacements: BatchPlacementInput[] = [
    { id: 'p1', placementIdentityId: 'id1', positionX: 200, positionY: 100, spatialClass: 'PHYSICAL', currentLabel: null },
    { id: 'p2', placementIdentityId: 'id2', positionX: 100, positionY: 100, spatialClass: 'PHYSICAL', currentLabel: 'OLD-1' },
    { id: 'p3', placementIdentityId: 'id3', positionX: 100, positionY: 200, spatialClass: 'PHYSICAL', currentLabel: null },
    { id: 'p4', placementIdentityId: 'id4', positionX: 50, positionY: 50, spatialClass: 'ZONE', currentLabel: null },
  ];

  describe('orderPlacements', () => {
    it('preserves SELECTION order', () => {
      const selected = ['p3', 'p1', 'p2'];
      const ordered = orderPlacements(samplePlacements.filter((p) => selected.includes(p.id)), 'SELECTION', selected);
      expect(ordered.map((p) => p.id)).toEqual(['p3', 'p1', 'p2']);
    });

    it('orders by ROW_MAJOR (Y ascending, then X ascending)', () => {
      const selected = ['p3', 'p1', 'p2'];
      const ordered = orderPlacements(samplePlacements.filter((p) => selected.includes(p.id)), 'ROW_MAJOR');
      // p2 is (100, 100), p1 is (200, 100), p3 is (100, 200)
      expect(ordered.map((p) => p.id)).toEqual(['p2', 'p1', 'p3']);
    });

    it('orders by COLUMN_MAJOR (X ascending, then Y ascending)', () => {
      const selected = ['p1', 'p2', 'p3'];
      const ordered = orderPlacements(samplePlacements.filter((p) => selected.includes(p.id)), 'COLUMN_MAJOR');
      // p2 is (100, 100), p3 is (100, 200), p1 is (200, 100)
      expect(ordered.map((p) => p.id)).toEqual(['p2', 'p3', 'p1']);
    });
  });

  describe('generateBatchLabels', () => {
    it('generates sequential labels with padding', () => {
      const items = [samplePlacements[0]!, samplePlacements[1]!];
      const proposed = generateBatchLabels(items, {
        prefix: 'D-',
        startNumber: 1,
        width: 3,
      });

      expect(proposed).toEqual([
        { placementId: 'p1', label: 'D-001' },
        { placementId: 'p2', label: 'D-002' },
      ]);
    });

    it('handles width 1 without leading zeros', () => {
      const items = [samplePlacements[0]!];
      const proposed = generateBatchLabels(items, {
        prefix: 'ROOM-',
        startNumber: 42,
        width: 1,
      });

      expect(proposed).toEqual([
        { placementId: 'p1', label: 'ROOM-42' },
      ]);
    });
  });

  describe('detectLabelConflicts', () => {
    it('detects ineligible spaces (e.g. ZONE or OBSTACLE)', () => {
      const conflicts = detectLabelConflicts({
        selectedPlacements: [samplePlacements[3]!], // ZONE
        proposedAssignments: [{ placementId: 'p4', label: 'D-001' }],
        existingRevisionPlacements: samplePlacements,
      });

      expect(conflicts).toContainEqual(
        expect.objectContaining({
          type: 'ineligible_space',
          placementId: 'p4',
        }),
      );
    });

    it('detects duplicates within the proposed batch', () => {
      const conflicts = detectLabelConflicts({
        selectedPlacements: [samplePlacements[0]!, samplePlacements[1]!],
        proposedAssignments: [
          { placementId: 'p1', label: 'D-001' },
          { placementId: 'p2', label: 'D-001' },
        ],
        existingRevisionPlacements: samplePlacements,
      });

      expect(conflicts).toContainEqual(
        expect.objectContaining({
          type: 'duplicate',
          label: 'D-001',
        }),
      );
    });

    it('detects collision with existing unselected placement labels', () => {
      // p2 has label 'OLD-1' and is unselected
      const conflicts = detectLabelConflicts({
        selectedPlacements: [samplePlacements[0]!],
        proposedAssignments: [{ placementId: 'p1', label: 'OLD-1' }],
        existingRevisionPlacements: samplePlacements,
      });

      expect(conflicts).toContainEqual(
        expect.objectContaining({
          type: 'collision',
          placementId: 'p1',
          label: 'OLD-1',
        }),
      );
    });

    it('allows relabeling if the existing label is on a selected placement being relabeled', () => {
      // p2 currently has 'OLD-1'. If p2 is selected and proposed 'D-002', and p1 is selected and proposed 'OLD-1', that's fine if handled,
      // but if p1 is proposed 'OLD-1' and p2 is NOT in the batch, that's a collision.
      const conflicts = detectLabelConflicts({
        selectedPlacements: [samplePlacements[1]!],
        proposedAssignments: [{ placementId: 'p2', label: 'D-002' }],
        existingRevisionPlacements: samplePlacements,
      });

      expect(conflicts).toHaveLength(0);
    });
  });

  describe('computeBatchPreviewToken', () => {
    it('produces deterministic sha256 token', () => {
      const token1 = computeBatchPreviewToken('rev-1', 5, [
        { placementId: 'p1', label: 'D-001' },
        { placementId: 'p2', label: 'D-002' },
      ]);
      const token2 = computeBatchPreviewToken('rev-1', 5, [
        { placementId: 'p2', label: 'D-002' },
        { placementId: 'p1', label: 'D-001' },
      ]);
      const token3 = computeBatchPreviewToken('rev-1', 6, [
        { placementId: 'p1', label: 'D-001' },
        { placementId: 'p2', label: 'D-002' },
      ]);

      expect(token1).toBe(token2);
      expect(token1).not.toBe(token3);
    });
  });
});
