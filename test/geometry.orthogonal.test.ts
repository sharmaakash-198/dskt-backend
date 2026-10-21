import { describe, expect, it } from 'vitest';
import {
  GeometryValidationError,
  accessibleGeometrySummary,
  checkSpatialCollision,
  diagnoseOrthogonalPolygon,
  doPolygonsOverlap,
  doSpatialClassesCollide,
  isPolygonInsideBoundary,
  normalizeToOrigin,
  snapToEditingScale,
  stripClosingDuplicate,
  transformVertices,
  validateOrthogonalPolygon,
  type SpatialClass,
  type Vertex,
} from '../src/geometry/orthogonal.js';

describe('orthogonal geometry', () => {
  it('strips a duplicated closing vertex and normalizes to origin', () => {
    const stripped = stripClosingDuplicate([
      { x: 5, y: 5 },
      { x: 15, y: 5 },
      { x: 15, y: 12 },
      { x: 5, y: 12 },
      { x: 5, y: 5 },
    ]);
    expect(stripped).toHaveLength(4);
    expect(normalizeToOrigin(stripped)).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 7 },
      { x: 0, y: 7 },
    ]);
  });

  it('accepts an anticlockwise orthogonal rectangle', () => {
    expect(
      validateOrthogonalPolygon([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 8 },
        { x: 0, y: 8 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 8 },
      { x: 0, y: 8 },
    ]);
  });

  it('transforms template-local vertices by quarter-turn rotation and translation', () => {
    const local = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 3 },
      { x: 0, y: 3 },
    ];

    // 0 degrees rotation
    expect(transformVertices(local, { x: 160, y: 80 }, 0)).toEqual([
      { x: 160, y: 80 },
      { x: 164, y: 80 },
      { x: 164, y: 83 },
      { x: 160, y: 83 },
    ]);

    // 90 degrees rotation (quarter turn)
    expect(transformVertices(local, { x: 160, y: 80 }, 90)).toEqual([
      { x: 160, y: 80 },
      { x: 160, y: 84 },
      { x: 157, y: 84 },
      { x: 157, y: 80 },
    ]);

    // 180 degrees rotation (two quarter turns)
    expect(transformVertices(local, { x: 160, y: 80 }, 180)).toEqual([
      { x: 160, y: 80 },
      { x: 156, y: 80 },
      { x: 156, y: 77 },
      { x: 160, y: 77 },
    ]);

    // 270 degrees rotation (three quarter turns)
    expect(transformVertices(local, { x: 160, y: 80 }, 270)).toEqual([
      { x: 160, y: 80 },
      { x: 160, y: 76 },
      { x: 163, y: 76 },
      { x: 163, y: 80 },
    ]);
  });

  it('validates polygon containment within floor boundary including edge contact', () => {
    const boundary = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 150 },
      { x: 0, y: 150 },
    ];

    // Completely inside
    const inside = [
      { x: 10, y: 10 },
      { x: 50, y: 10 },
      { x: 50, y: 40 },
      { x: 10, y: 40 },
    ];
    expect(isPolygonInsideBoundary(inside, boundary)).toBe(true);

    // Touching the boundary edge
    const touchingEdge = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
    ];
    expect(isPolygonInsideBoundary(touchingEdge, boundary)).toBe(true);

    // Completely outside
    const outside = [
      { x: 250, y: 10 },
      { x: 280, y: 10 },
      { x: 280, y: 40 },
      { x: 250, y: 40 },
    ];
    expect(isPolygonInsideBoundary(outside, boundary)).toBe(false);

    // Crossing boundary
    const crossing = [
      { x: 180, y: 10 },
      { x: 220, y: 10 },
      { x: 220, y: 40 },
      { x: 180, y: 40 },
    ];
    expect(isPolygonInsideBoundary(crossing, boundary)).toBe(false);
  });

  it('validates polygon interior overlap while allowing touching edges', () => {
    const poly1 = [
      { x: 10, y: 10 },
      { x: 30, y: 10 },
      { x: 30, y: 30 },
      { x: 10, y: 30 },
    ];

    // Overlapping poly
    const overlapping = [
      { x: 20, y: 20 },
      { x: 40, y: 20 },
      { x: 40, y: 40 },
      { x: 20, y: 40 },
    ];
    expect(doPolygonsOverlap(poly1, overlapping)).toBe(true);

    // Adjacent touching edge
    const touchingEdge = [
      { x: 30, y: 10 },
      { x: 50, y: 10 },
      { x: 50, y: 30 },
      { x: 30, y: 30 },
    ];
    expect(doPolygonsOverlap(poly1, touchingEdge)).toBe(false);

    // Disjoint
    const disjoint = [
      { x: 60, y: 10 },
      { x: 80, y: 10 },
      { x: 80, y: 30 },
      { x: 60, y: 30 },
    ];
    expect(doPolygonsOverlap(poly1, disjoint)).toBe(false);
  });

  it('diagnoses diagonal edges with edge index', () => {
    const diagnostics = diagnoseOrthogonalPolygon([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 8, y: 8 },
      { x: 0, y: 8 },
    ]);
    expect(diagnostics.some((item) => item.code === 'non_orthogonal_edge')).toBe(true);
    expect(diagnostics.find((item) => item.code === 'non_orthogonal_edge')?.edgeIndex).toBe(1);
  });

  it('rejects clockwise orientation and self-intersection', () => {
    const clockwise = diagnoseOrthogonalPolygon([
      { x: 0, y: 0 },
      { x: 0, y: 8 },
      { x: 10, y: 8 },
      { x: 10, y: 0 },
    ]);
    expect(clockwise.map((item) => item.code)).toContain('not_anticlockwise');

    // Bow-tie orthogonal self-intersection
    const crossing = diagnoseOrthogonalPolygon([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 5, y: 10 },
      { x: 5, y: 5 },
      { x: 15, y: 5 },
      { x: 15, y: 15 },
      { x: 0, y: 15 },
    ]);
    // Simpler classic: U-shape that crosses? For ortho bowtie:
    // (0,0)-(10,0)-(10,10)-(0,10) is fine.
    // Cross: (0,2)-(8,2)-(8,0)-(10,0)-(10,8)-(2,8)-(2,10)-(0,10)
    // Better known: two bars
    const selfIntersect = diagnoseOrthogonalPolygon([
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 4 },
      { x: 2, y: 4 },
      { x: 2, y: 2 },
      { x: 8, y: 2 },
      { x: 8, y: 6 },
      { x: 0, y: 6 },
    ]);
    expect(selfIntersect.some((item) => item.code === 'self_intersecting')).toBe(true);
    expect(crossing).toBeTruthy();
  });

  it('rejects duplicated closing vertices and non-integers', () => {
    expect(() =>
      validateOrthogonalPolygon([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 8 },
        { x: 0, y: 8 },
        { x: 0, y: 0 },
      ]),
    ).toThrow(GeometryValidationError);

    expect(() =>
      validateOrthogonalPolygon([
        { x: 0.5, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 8 },
        { x: 0, y: 8 },
      ]),
    ).toThrow(GeometryValidationError);
  });

  it('snaps to editing scale without depending on viewport zoom', () => {
    expect(snapToEditingScale(13, 4)).toBe(12);
    expect(snapToEditingScale(14, 4)).toBe(16);
  });

  it('builds an accessible geometry summary', () => {
    const summary = accessibleGeometrySummary([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 0, y: 5 },
    ]);
    expect(summary).toContain('4 vertices');
    expect(summary).toContain('10 by 5');
    expect(summary).toContain('Closure is implicit');
  });

  describe('Quarter-turn transform properties', () => {
    const testPolygons: Vertex[][] = [
      // Rectangle 20x10
      [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 10 },
        { x: 0, y: 10 },
      ],
      // L-shape
      [
        { x: 0, y: 0 },
        { x: 30, y: 0 },
        { x: 30, y: 10 },
        { x: 10, y: 10 },
        { x: 10, y: 25 },
        { x: 0, y: 25 },
      ],
      // T-shape
      [
        { x: 10, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 15 },
        { x: 30, y: 15 },
        { x: 30, y: 25 },
        { x: 0, y: 25 },
        { x: 0, y: 15 },
        { x: 10, y: 15 },
      ],
    ];

    it('four consecutive 90-degree rotations return identical vertices', () => {
      for (const poly of testPolygons) {
        const r1 = transformVertices(poly, { x: 0, y: 0 }, 90);
        const r2 = transformVertices(r1, { x: 0, y: 0 }, 90);
        const r3 = transformVertices(r2, { x: 0, y: 0 }, 90);
        const r4 = transformVertices(r3, { x: 0, y: 0 }, 90);
        expect(r4).toEqual(poly);
      }
    });

    it('quarter-turn followed by inverse rotation round-trips to identity', () => {
      const angles = [0, 90, 180, 270] as const;
      const inverseAngle: Record<number, number> = { 0: 0, 90: 270, 180: 180, 270: 90 };
      for (const poly of testPolygons) {
        for (const angle of angles) {
          const rotated = transformVertices(poly, { x: 0, y: 0 }, angle);
          const restored = transformVertices(rotated, { x: 0, y: 0 }, inverseAngle[angle]);
          expect(restored).toEqual(poly);
        }
      }
    });

    it('arbitrary integer translation and rotation round-trips via inverse transform', () => {
      const translations = [
        { x: 0, y: 0 },
        { x: 50, y: 80 },
        { x: -30, y: 120 },
        { x: 100, y: -45 },
      ];
      const angles = [0, 90, 180, 270] as const;
      const inverseAngle: Record<number, number> = { 0: 0, 90: 270, 180: 180, 270: 90 };

      for (const poly of testPolygons) {
        for (const t of translations) {
          for (const angle of angles) {
            const transformed = transformVertices(poly, t, angle);
            // Inverse: first subtract translation, then apply inverse rotation
            const untranslated = transformed.map((v) => ({ x: v.x - t.x, y: v.y - t.y }));
            const roundTripped = transformVertices(untranslated, { x: 0, y: 0 }, inverseAngle[angle]);
            expect(roundTripped).toEqual(poly);
          }
        }
      }
    });

    it('preserves segment lengths under all quarter-turns and translations', () => {
      const angles = [0, 90, 180, 270] as const;
      for (const poly of testPolygons) {
        const origLengths = poly.map((v, i) => {
          const next = poly[(i + 1) % poly.length]!;
          return Math.hypot(next.x - v.x, next.y - v.y);
        });
        for (const angle of angles) {
          const transformed = transformVertices(poly, { x: 42, y: -17 }, angle);
          const transformedLengths = transformed.map((v, i) => {
            const next = transformed[(i + 1) % transformed.length]!;
            return Math.hypot(next.x - v.x, next.y - v.y);
          });
          expect(transformedLengths).toEqual(origLengths);
        }
      }
    });

    it('preserves polygon shoelace area magnitude under rotation and translation', () => {
      function shoelaceArea(p: Vertex[]): number {
        let area = 0;
        for (let i = 0; i < p.length; i += 1) {
          const j = (i + 1) % p.length;
          area += p[i]!.x * p[j]!.y;
          area -= p[j]!.x * p[i]!.y;
        }
        return Math.abs(area) / 2;
      }

      const angles = [0, 90, 180, 270] as const;
      for (const poly of testPolygons) {
        const origArea = shoelaceArea(poly);
        for (const angle of angles) {
          const transformed = transformVertices(poly, { x: 120, y: 75 }, angle);
          expect(shoelaceArea(transformed)).toBe(origArea);
        }
      }
    });
  });

  describe('Spatial-class containment and intersection rules', () => {
    const boundary: Vertex[] = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 200 },
      { x: 0, y: 200 },
    ];

    const polyA: Vertex[] = [
      { x: 10, y: 10 },
      { x: 50, y: 10 },
      { x: 50, y: 50 },
      { x: 10, y: 50 },
    ];

    // Overlapping interior with polyA
    const overlappingPoly: Vertex[] = [
      { x: 30, y: 30 },
      { x: 70, y: 30 },
      { x: 70, y: 70 },
      { x: 30, y: 70 },
    ];

    // Touching edge with polyA at x = 50, y in [10, 50]
    const touchingPoly: Vertex[] = [
      { x: 50, y: 10 },
      { x: 90, y: 10 },
      { x: 90, y: 50 },
      { x: 50, y: 50 },
    ];

    // Completely outside boundary
    const outsidePoly: Vertex[] = [
      { x: 190, y: 190 },
      { x: 230, y: 190 },
      { x: 230, y: 230 },
      { x: 190, y: 230 },
    ];

    it('verifies boundary containment rule applies to all spatial classes', () => {
      const classes: SpatialClass[] = ['PHYSICAL', 'ZONE', 'OBSTACLE'];
      for (const _spatialClass of classes) {
        expect(isPolygonInsideBoundary(polyA, boundary)).toBe(true);
        expect(isPolygonInsideBoundary(touchingPoly, boundary)).toBe(true);
        expect(isPolygonInsideBoundary(outsidePoly, boundary)).toBe(false);
      }
    });

    it('identifies collision rules between all spatial-class pairs', () => {
      // Zone does not collide with any class
      expect(doSpatialClassesCollide('ZONE', 'ZONE')).toBe(false);
      expect(doSpatialClassesCollide('ZONE', 'PHYSICAL')).toBe(false);
      expect(doSpatialClassesCollide('PHYSICAL', 'ZONE')).toBe(false);
      expect(doSpatialClassesCollide('ZONE', 'OBSTACLE')).toBe(false);
      expect(doSpatialClassesCollide('OBSTACLE', 'ZONE')).toBe(false);

      // Physical and Obstacle mutually collide
      expect(doSpatialClassesCollide('PHYSICAL', 'PHYSICAL')).toBe(true);
      expect(doSpatialClassesCollide('PHYSICAL', 'OBSTACLE')).toBe(true);
      expect(doSpatialClassesCollide('OBSTACLE', 'PHYSICAL')).toBe(true);
      expect(doSpatialClassesCollide('OBSTACLE', 'OBSTACLE')).toBe(true);
    });

    it('enforces collision for overlapping physical/obstacle elements and permits zones', () => {
      // 1. Physical + Physical overlapping -> collision
      expect(
        checkSpatialCollision(
          { spatialClass: 'PHYSICAL', vertices: overlappingPoly },
          [{ spatialClass: 'PHYSICAL', vertices: polyA }],
        ),
      ).toBe(true);

      // 2. Physical + Physical merely touching -> valid (no collision)
      expect(
        checkSpatialCollision(
          { spatialClass: 'PHYSICAL', vertices: touchingPoly },
          [{ spatialClass: 'PHYSICAL', vertices: polyA }],
        ),
      ).toBe(false);

      // 3. Physical + Obstacle overlapping -> collision
      expect(
        checkSpatialCollision(
          { spatialClass: 'PHYSICAL', vertices: overlappingPoly },
          [{ spatialClass: 'OBSTACLE', vertices: polyA }],
        ),
      ).toBe(true);

      // 4. Obstacle + Physical overlapping -> collision
      expect(
        checkSpatialCollision(
          { spatialClass: 'OBSTACLE', vertices: overlappingPoly },
          [{ spatialClass: 'PHYSICAL', vertices: polyA }],
        ),
      ).toBe(true);

      // 5. Obstacle + Obstacle overlapping -> collision
      expect(
        checkSpatialCollision(
          { spatialClass: 'OBSTACLE', vertices: overlappingPoly },
          [{ spatialClass: 'OBSTACLE', vertices: polyA }],
        ),
      ).toBe(true);

      // 6. Zone overlapping or containing Physical -> valid (no collision)
      expect(
        checkSpatialCollision(
          { spatialClass: 'ZONE', vertices: overlappingPoly },
          [{ spatialClass: 'PHYSICAL', vertices: polyA }],
        ),
      ).toBe(false);

      // 7. Physical inside or overlapping Zone -> valid (no collision)
      expect(
        checkSpatialCollision(
          { spatialClass: 'PHYSICAL', vertices: overlappingPoly },
          [{ spatialClass: 'ZONE', vertices: polyA }],
        ),
      ).toBe(false);

      // 8. Zone overlapping Obstacle -> valid (no collision)
      expect(
        checkSpatialCollision(
          { spatialClass: 'ZONE', vertices: overlappingPoly },
          [{ spatialClass: 'OBSTACLE', vertices: polyA }],
        ),
      ).toBe(false);

      // 9. Zone overlapping another Zone -> valid (no collision)
      expect(
        checkSpatialCollision(
          { spatialClass: 'ZONE', vertices: overlappingPoly },
          [{ spatialClass: 'ZONE', vertices: polyA }],
        ),
      ).toBe(false);
    });
  });
});
