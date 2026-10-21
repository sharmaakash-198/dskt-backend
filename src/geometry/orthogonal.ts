/**
 * Integer orthogonal polygon helpers for template-local geometry.
 * Coordinates are world units (1 unit = 10 cm). Unaware of persistence/viewport.
 */

export type Vertex = { x: number; y: number };

export type GeometryErrorCode =
  | 'invalid_vertex_coordinates'
  | 'invalid_vertex_count'
  | 'non_orthogonal_edge'
  | 'zero_length_edge'
  | 'duplicate_closing_vertex'
  | 'repeated_vertex'
  | 'self_intersecting'
  | 'not_anticlockwise'
  | 'degenerate_polygon';

export type GeometryDiagnostic = {
  code: GeometryErrorCode;
  message: string;
  vertexIndex?: number;
  edgeIndex?: number;
};

export class GeometryError extends Error {
  constructor(
    readonly code: GeometryErrorCode,
    readonly vertexIndex?: number,
    readonly edgeIndex?: number,
  ) {
    super(code);
    this.name = 'GeometryError';
  }
}

export class GeometryValidationError extends Error {
  constructor(readonly diagnostics: GeometryDiagnostic[]) {
    super('invalid_geometry');
    this.name = 'GeometryValidationError';
  }
}

function isInteger(value: number): boolean {
  return Number.isInteger(value) && Number.isFinite(value);
}

function diagnostic(
  code: GeometryErrorCode,
  message: string,
  loc?: { vertexIndex?: number; edgeIndex?: number },
): GeometryDiagnostic {
  return {
    code,
    message,
    vertexIndex: loc?.vertexIndex,
    edgeIndex: loc?.edgeIndex,
  };
}

/** Drop an explicit closing vertex that duplicates the first point. */
export function stripClosingDuplicate(vertices: Vertex[]): Vertex[] {
  if (vertices.length < 2) {
    return [...vertices];
  }
  const first = vertices[0]!;
  const last = vertices[vertices.length - 1]!;
  if (first.x === last.x && first.y === last.y) {
    return vertices.slice(0, -1);
  }
  return [...vertices];
}

/** Translate so the bounding-box minimum sits at the origin. */
export function normalizeToOrigin(vertices: Vertex[]): Vertex[] {
  if (vertices.length === 0) {
    return [];
  }
  let minX = vertices[0]!.x;
  let minY = vertices[0]!.y;
  for (const vertex of vertices) {
    if (vertex.x < minX) minX = vertex.x;
    if (vertex.y < minY) minY = vertex.y;
  }
  return vertices.map((vertex) => ({ x: vertex.x - minX, y: vertex.y - minY }));
}

/** Signed double area via shoelace; positive means anticlockwise in standard Cartesian. */
export function signedDoubleArea(vertices: Vertex[]): number {
  let area = 0;
  for (let index = 0; index < vertices.length; index += 1) {
    const current = vertices[index]!;
    const next = vertices[(index + 1) % vertices.length]!;
    area += current.x * next.y - next.x * current.y;
  }
  return area;
}

function segmentsProperlyIntersect(
  a1: Vertex,
  a2: Vertex,
  b1: Vertex,
  b2: Vertex,
): boolean {
  // Orthogonal segments only: axis-aligned overlap that is not mere touching at endpoints.
  const aHorizontal = a1.y === a2.y;
  const bHorizontal = b1.y === b2.y;
  if (aHorizontal === bHorizontal) {
    if (aHorizontal) {
      if (a1.y !== b1.y) return false;
      const aMin = Math.min(a1.x, a2.x);
      const aMax = Math.max(a1.x, a2.x);
      const bMin = Math.min(b1.x, b2.x);
      const bMax = Math.max(b1.x, b2.x);
      return aMin < bMax && bMin < aMax;
    }
    if (a1.x !== b1.x) return false;
    const aMin = Math.min(a1.y, a2.y);
    const aMax = Math.max(a1.y, a2.y);
    const bMin = Math.min(b1.y, b2.y);
    const bMax = Math.max(b1.y, b2.y);
    return aMin < bMax && bMin < aMax;
  }
  const h1 = aHorizontal ? a1 : b1;
  const h2 = aHorizontal ? a2 : b2;
  const v1 = aHorizontal ? b1 : a1;
  const v2 = aHorizontal ? b2 : a2;
  const y = h1.y;
  const x = v1.x;
  const hMin = Math.min(h1.x, h2.x);
  const hMax = Math.max(h1.x, h2.x);
  const vMin = Math.min(v1.y, v2.y);
  const vMax = Math.max(v1.y, v2.y);
  // Proper crossing (not endpoint touch): x strictly inside horizontal span and y strictly inside vertical.
  return x > hMin && x < hMax && y > vMin && y < vMax;
}

export function findSelfIntersections(vertices: Vertex[]): number[] {
  const edges: number[] = [];
  const count = vertices.length;
  for (let i = 0; i < count; i += 1) {
    const a1 = vertices[i]!;
    const a2 = vertices[(i + 1) % count]!;
    for (let j = i + 1; j < count; j += 1) {
      // Skip adjacent edges and the closing pair (0 and n-1).
      if (Math.abs(i - j) <= 1) continue;
      if (i === 0 && j === count - 1) continue;
      const b1 = vertices[j]!;
      const b2 = vertices[(j + 1) % count]!;
      if (segmentsProperlyIntersect(a1, a2, b1, b2)) {
        edges.push(i, j);
      }
    }
  }
  return [...new Set(edges)].sort((a, b) => a - b);
}

export function diagnoseOrthogonalPolygon(raw: Vertex[]): GeometryDiagnostic[] {
  const diagnostics: GeometryDiagnostic[] = [];

  for (let index = 0; index < raw.length; index += 1) {
    const vertex = raw[index]!;
    if (!isInteger(vertex.x) || !isInteger(vertex.y)) {
      diagnostics.push(
        diagnostic('invalid_vertex_coordinates', 'Vertex coordinates must be integers.', {
          vertexIndex: index,
        }),
      );
    }
  }
  if (diagnostics.length > 0) {
    return diagnostics;
  }

  if (raw.length >= 2) {
    const first = raw[0]!;
    const last = raw[raw.length - 1]!;
    if (first.x === last.x && first.y === last.y) {
      diagnostics.push(
        diagnostic(
          'duplicate_closing_vertex',
          'Do not repeat the first vertex to close the polygon; closure is implicit.',
          { vertexIndex: raw.length - 1 },
        ),
      );
      return diagnostics;
    }
  }

  const vertices = stripClosingDuplicate(raw);
  if (vertices.length < 4 || vertices.length > 100) {
    diagnostics.push(
      diagnostic(
        'invalid_vertex_count',
        'Polygons must have between 4 and 100 vertices (implicit closure).',
      ),
    );
    return diagnostics;
  }

  const seen = new Map<string, number>();
  for (let index = 0; index < vertices.length; index += 1) {
    const vertex = vertices[index]!;
    const key = `${vertex.x},${vertex.y}`;
    const prior = seen.get(key);
    if (prior !== undefined) {
      diagnostics.push(
        diagnostic('repeated_vertex', `Vertex repeats an earlier point at index ${prior}.`, {
          vertexIndex: index,
        }),
      );
    } else {
      seen.set(key, index);
    }
  }

  for (let index = 0; index < vertices.length; index += 1) {
    const current = vertices[index]!;
    const next = vertices[(index + 1) % vertices.length]!;
    const dx = next.x - current.x;
    const dy = next.y - current.y;
    if (dx === 0 && dy === 0) {
      diagnostics.push(
        diagnostic('zero_length_edge', 'Edge length must be non-zero.', {
          edgeIndex: index,
          vertexIndex: index,
        }),
      );
    } else if (dx !== 0 && dy !== 0) {
      diagnostics.push(
        diagnostic('non_orthogonal_edge', 'Edges must be horizontal or vertical.', {
          edgeIndex: index,
          vertexIndex: index,
        }),
      );
    }
  }

  if (diagnostics.length > 0) {
    return diagnostics;
  }

  const area = signedDoubleArea(vertices);
  if (area === 0) {
    diagnostics.push(
      diagnostic('degenerate_polygon', 'Polygon area must be non-zero.'),
    );
    return diagnostics;
  }
  if (area < 0) {
    diagnostics.push(
      diagnostic(
        'not_anticlockwise',
        'Vertices must be ordered anticlockwise (counter-clockwise).',
      ),
    );
  }

  for (const edgeIndex of findSelfIntersections(vertices)) {
    diagnostics.push(
      diagnostic('self_intersecting', 'Polygon edges must not properly intersect.', {
        edgeIndex,
        vertexIndex: edgeIndex,
      }),
    );
  }

  return diagnostics;
}

export function validateOrthogonalPolygon(raw: Vertex[]): Vertex[] {
  const diagnostics = diagnoseOrthogonalPolygon(raw);
  if (diagnostics.length > 0) {
    throw new GeometryValidationError(diagnostics);
  }
  return normalizeToOrigin(stripClosingDuplicate(raw));
}

export function snapToEditingScale(value: number, scale: number): number {
  if (!Number.isInteger(scale) || scale < 1) {
    return Math.round(value);
  }
  return Math.round(value / scale) * scale;
}

export function polygonBounds(vertices: Vertex[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
} {
  let minX = vertices[0]!.x;
  let minY = vertices[0]!.y;
  let maxX = vertices[0]!.x;
  let maxY = vertices[0]!.y;
  for (const vertex of vertices) {
    if (vertex.x < minX) minX = vertex.x;
    if (vertex.y < minY) minY = vertex.y;
    if (vertex.x > maxX) maxX = vertex.x;
    if (vertex.y > maxY) maxY = vertex.y;
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function accessibleGeometrySummary(vertices: Vertex[]): string {
  const bounds = polygonBounds(vertices);
  const edges = vertices.map((vertex, index) => {
    const next = vertices[(index + 1) % vertices.length]!;
    const axis = next.x === vertex.x ? 'vertical' : 'horizontal';
    const length = Math.abs(next.x - vertex.x) + Math.abs(next.y - vertex.y);
    return `${axis} ${length}`;
  });
  return (
    `${vertices.length} vertices; ${bounds.width} by ${bounds.height} world units; ` +
    `edges: ${edges.join(', ')}. Closure is implicit.`
  );
}

export const PERMITTED_ROTATION_DEGREES = [0, 90, 180, 270] as const;
export type PermittedRotationDegrees = (typeof PERMITTED_ROTATION_DEGREES)[number];

export function transformVertices(
  vertices: Vertex[],
  translation: Vertex,
  rotationDegrees: number = 0,
): Vertex[] {
  if (![0, 90, 180, 270].includes(rotationDegrees)) {
    throw new Error(`Invalid rotation degrees: ${rotationDegrees}. Must be 0, 90, 180, or 270.`);
  }

  return vertices.map((v) => {
    let rx = v.x;
    let ry = v.y;
    if (rotationDegrees === 90) {
      rx = -v.y;
      ry = v.x;
    } else if (rotationDegrees === 180) {
      rx = -v.x;
      ry = -v.y;
    } else if (rotationDegrees === 270) {
      rx = v.y;
      ry = -v.x;
    }
    return {
      x: translation.x + rx,
      y: translation.y + ry,
    };
  });
}

/** Check if point is on any edge of the orthogonal polygon. */
export function isPointOnPolygonBoundary(point: { x: number; y: number }, polygon: Vertex[]): boolean {
  const count = polygon.length;
  for (let i = 0; i < count; i += 1) {
    const p1 = polygon[i]!;
    const p2 = polygon[(i + 1) % count]!;
    if (p1.y === p2.y) {
      // Horizontal edge
      if (Math.abs(point.y - p1.y) < 1e-9) {
        const minX = Math.min(p1.x, p2.x);
        const maxX = Math.max(p1.x, p2.x);
        if (point.x >= minX - 1e-9 && point.x <= maxX + 1e-9) {
          return true;
        }
      }
    } else if (p1.x === p2.x) {
      // Vertical edge
      if (Math.abs(point.x - p1.x) < 1e-9) {
        const minY = Math.min(p1.y, p2.y);
        const maxY = Math.max(p1.y, p2.y);
        if (point.y >= minY - 1e-9 && point.y <= maxY + 1e-9) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Ray-casting test for whether a point is inside (or on) an orthogonal polygon. */
export function isPointInsideOrOnPolygon(point: { x: number; y: number }, polygon: Vertex[]): boolean {
  if (isPointOnPolygonBoundary(point, polygon)) {
    return true;
  }
  return isPointStrictlyInsidePolygon(point, polygon);
}

/** Ray-casting test for whether a point is strictly inside an orthogonal polygon (not on edge). */
export function isPointStrictlyInsidePolygon(point: { x: number; y: number }, polygon: Vertex[]): boolean {
  if (isPointOnPolygonBoundary(point, polygon)) {
    return false;
  }
  let inside = false;
  const count = polygon.length;
  for (let i = 0; i < count; i += 1) {
    const p1 = polygon[i]!;
    const p2 = polygon[(i + 1) % count]!;
    // In orthogonal polygons, only vertical edges can cross a horizontal ray
    if (p1.x === p2.x) {
      // Ray crosses if point.y is strictly between the y values (half-open interval)
      const intersects = (p1.y <= point.y && point.y < p2.y) || (p2.y <= point.y && point.y < p1.y);
      if (intersects && p1.x > point.x) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** Returns an interior point of an orthogonal polygon (by stepping inward from a convex vertex). */
export function getPolygonInteriorPoint(polygon: Vertex[]): { x: number; y: number } {
  const count = polygon.length;
  for (let i = 0; i < count; i += 1) {
    const prev = polygon[(i + count - 1) % count]!;
    const curr = polygon[i]!;
    const next = polygon[(i + 1) % count]!;

    const inDx = Math.sign(curr.x - prev.x);
    const inDy = Math.sign(curr.y - prev.y);
    const outDx = Math.sign(next.x - curr.x);
    const outDy = Math.sign(next.y - curr.y);
    const cross = inDx * outDy - inDy * outDx;
    if (cross > 0) {
      // Convex vertex in anticlockwise polygon: step inward
      const testPoint = {
        x: curr.x - 0.5 * inDx + 0.5 * outDx,
        y: curr.y - 0.5 * inDy + 0.5 * outDy,
      };
      if (isPointStrictlyInsidePolygon(testPoint, polygon)) {
        return testPoint;
      }
    }
  }
  // Fallback: average of vertices
  let sumX = 0;
  let sumY = 0;
  for (const v of polygon) {
    sumX += v.x;
    sumY += v.y;
  }
  return { x: sumX / count, y: sumY / count };
}

export function segmentsCrossProperly(
  a1: { x: number; y: number },
  a2: { x: number; y: number },
  b1: { x: number; y: number },
  b2: { x: number; y: number },
): boolean {
  const aHorizontal = a1.y === a2.y;
  const bHorizontal = b1.y === b2.y;
  if (aHorizontal === bHorizontal) {
    return false;
  }
  const h1 = aHorizontal ? a1 : b1;
  const h2 = aHorizontal ? a2 : b2;
  const v1 = aHorizontal ? b1 : a1;
  const v2 = aHorizontal ? b2 : a2;
  const y = h1.y;
  const x = v1.x;
  const hMin = Math.min(h1.x, h2.x);
  const hMax = Math.max(h1.x, h2.x);
  const vMin = Math.min(v1.y, v2.y);
  const vMax = Math.max(v1.y, v2.y);
  return x > hMin && x < hMax && y > vMin && y < vMax;
}

/**
 * Checks whether an orthogonal polygon is completely contained within a boundary polygon.
 * Boundary containment includes edge contact.
 */
export function isPolygonInsideBoundary(polygon: Vertex[], boundary: Vertex[]): boolean {
  if (boundary.length < 4 || polygon.length < 4) {
    return false;
  }

  // 1. All vertices of polygon must be inside or on the boundary
  for (const v of polygon) {
    if (!isPointInsideOrOnPolygon(v, boundary)) {
      return false;
    }
  }

  // 2. No edge of polygon may properly cross any edge of boundary
  const pCount = polygon.length;
  const bCount = boundary.length;
  for (let i = 0; i < pCount; i += 1) {
    const a1 = polygon[i]!;
    const a2 = polygon[(i + 1) % pCount]!;
    for (let j = 0; j < bCount; j += 1) {
      const b1 = boundary[j]!;
      const b2 = boundary[(j + 1) % bCount]!;
      if (segmentsCrossProperly(a1, a2, b1, b2)) {
        return false;
      }
    }
  }

  // 3. Edge midpoints must be inside or on boundary
  for (let i = 0; i < pCount; i += 1) {
    const a1 = polygon[i]!;
    const a2 = polygon[(i + 1) % pCount]!;
    const mid = { x: (a1.x + a2.x) / 2, y: (a1.y + a2.y) / 2 };
    if (!isPointInsideOrOnPolygon(mid, boundary)) {
      return false;
    }
  }

  // 4. An interior point of the polygon must be strictly inside the boundary
  const interior = getPolygonInteriorPoint(polygon);
  return isPointStrictlyInsidePolygon(interior, boundary);
}

/**
 * Checks whether two orthogonal polygons overlap in their interiors.
 * Touching at edges or vertices is permitted (returns false).
 */
export function doPolygonsOverlap(polyA: Vertex[], polyB: Vertex[]): boolean {
  if (polyA.length < 4 || polyB.length < 4) {
    return false;
  }

  // 1. Check for properly crossing edges
  const aCount = polyA.length;
  const bCount = polyB.length;
  for (let i = 0; i < aCount; i += 1) {
    const a1 = polyA[i]!;
    const a2 = polyA[(i + 1) % aCount]!;
    for (let j = 0; j < bCount; j += 1) {
      const b1 = polyB[j]!;
      const b2 = polyB[(j + 1) % bCount]!;
      if (segmentsCrossProperly(a1, a2, b1, b2)) {
        return true;
      }
    }
  }

  // 2. Check if any vertex of polyA is strictly inside polyB
  for (const v of polyA) {
    if (isPointStrictlyInsidePolygon(v, polyB)) {
      return true;
    }
  }

  // 3. Check if any vertex of polyB is strictly inside polyA
  for (const v of polyB) {
    if (isPointStrictlyInsidePolygon(v, polyA)) {
      return true;
    }
  }

  // 4. Check if interior of polyA is inside polyB or vice versa
  const intA = getPolygonInteriorPoint(polyA);
  if (isPointStrictlyInsidePolygon(intA, polyB)) {
    return true;
  }
  const intB = getPolygonInteriorPoint(polyB);
  if (isPointStrictlyInsidePolygon(intB, polyA)) {
    return true;
  }

  return false;
}

export type SpatialClass = 'PHYSICAL' | 'ZONE' | 'OBSTACLE';

/**
 * Returns true if the two spatial classes have mutually exclusive footprints.
 * - Zones can contain physical elements and obstacles, and can overlap other zones.
 * - Physical elements and obstacles cannot overlap each other.
 */
export function doSpatialClassesCollide(classA: SpatialClass, classB: SpatialClass): boolean {
  return classA !== 'ZONE' && classB !== 'ZONE';
}

/**
 * Checks whether an element collides with any existing elements based on their spatial classes.
 */
export function checkSpatialCollision(
  element: { spatialClass: SpatialClass; vertices: Vertex[] },
  existing: { spatialClass: SpatialClass; vertices: Vertex[] }[],
): boolean {
  if (element.spatialClass === 'ZONE') return false;
  return existing.some(
    (other) =>
      doSpatialClassesCollide(element.spatialClass, other.spatialClass) &&
      doPolygonsOverlap(element.vertices, other.vertices),
  );
}
