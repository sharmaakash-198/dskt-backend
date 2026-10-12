import { describe, expect, it } from 'vitest';
import {
  GeometryValidationError,
  accessibleGeometrySummary,
  diagnoseOrthogonalPolygon,
  normalizeToOrigin,
  snapToEditingScale,
  stripClosingDuplicate,
  validateOrthogonalPolygon,
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
});
