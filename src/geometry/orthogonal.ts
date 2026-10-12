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
  | 'repeated_vertex';

export class GeometryError extends Error {
  constructor(readonly code: GeometryErrorCode) {
    super(code);
    this.name = 'GeometryError';
  }
}

function isInteger(value: number): boolean {
  return Number.isInteger(value) && Number.isFinite(value);
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

export function validateOrthogonalPolygon(raw: Vertex[]): Vertex[] {
  for (const vertex of raw) {
    if (!isInteger(vertex.x) || !isInteger(vertex.y)) {
      throw new GeometryError('invalid_vertex_coordinates');
    }
  }

  if (raw.length >= 2) {
    const first = raw[0]!;
    const last = raw[raw.length - 1]!;
    if (first.x === last.x && first.y === last.y) {
      throw new GeometryError('duplicate_closing_vertex');
    }
  }

  const vertices = stripClosingDuplicate(raw);
  if (vertices.length < 4 || vertices.length > 100) {
    throw new GeometryError('invalid_vertex_count');
  }

  const seen = new Set<string>();
  for (const vertex of vertices) {
    const key = `${vertex.x},${vertex.y}`;
    if (seen.has(key)) {
      throw new GeometryError('repeated_vertex');
    }
    seen.add(key);
  }

  for (let index = 0; index < vertices.length; index += 1) {
    const current = vertices[index]!;
    const next = vertices[(index + 1) % vertices.length]!;
    const dx = next.x - current.x;
    const dy = next.y - current.y;
    if (dx === 0 && dy === 0) {
      throw new GeometryError('zero_length_edge');
    }
    if (dx !== 0 && dy !== 0) {
      throw new GeometryError('non_orthogonal_edge');
    }
  }

  return normalizeToOrigin(vertices);
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
