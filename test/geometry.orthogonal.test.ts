import { describe, expect, it } from 'vitest';
import {
  GeometryError,
  accessibleGeometrySummary,
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

  it('accepts an orthogonal rectangle and rejects diagonal edges', () => {
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

    expect(() =>
      validateOrthogonalPolygon([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 8, y: 8 },
        { x: 0, y: 8 },
      ]),
    ).toThrow(GeometryError);
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
    ).toThrowError(/duplicate_closing_vertex/);

    expect(() =>
      validateOrthogonalPolygon([
        { x: 0.5, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 8 },
        { x: 0, y: 8 },
      ]),
    ).toThrowError(/invalid_vertex_coordinates/);
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
