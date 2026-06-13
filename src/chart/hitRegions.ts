/**
 * src/chart/hitRegions.ts — Shared overlay hotspot substrate.
 *
 * ONE shared `HitRegion[]` array (held in a single ref by ChartCanvas) collects
 * the interactive glyphs every overlay renderer draws each frame. The array is
 * reset in place (`length = 0`) exactly once at the TOP of the ChartCanvas draw
 * call; renderers ONLY push during their existing draw pass (they never reset).
 *
 * Coordinate space — IMPORTANT:
 *   Every region's x/y (and x2/y2) is in **CSS pixels** relative to the canvas
 *   top-left, the SAME space the renderers draw in (the 2D context is scaled by
 *   dpr via setTransform, so all draw coordinates are CSS px). Mousemove queries
 *   pass CSS px relative to the wrap element — same space — so no conversion is
 *   needed at the boundary.
 *
 * Hit-test geometry (per kind):
 *   - dots / glyphs (no x2): circle hit-test, radius `r ?? DOT_RADIUS_PX`.
 *   - lines (x2/y2 set, no rect kind): segment distance, `LINE_TOLERANCE_PX`.
 *   - ranges (rect kinds with x2): rect span x..x2 across full plot height
 *     (y..y2 when y2 set, else any y inside the band).
 *
 * Resolution exposes BOTH the NEAREST hit (default display) and the full set of
 * COINCIDENT hits within tolerance at that point (a later step renders a ‹N/M›
 * cycler over them).
 */

/** Discriminant for what kind of overlay glyph a region represents. */
export type HitRegionKind =
  | 'mark'
  | 'comment'
  | 'trend'
  | 'rangeEdge'
  | 'signal'
  | 'strategySignal'
  | 'timelinePin'
  | 'timelineVline'
  | 'timelineRange'
  | 'indicatorLast'
  | 'research';

/**
 * A single interactive hotspot in CSS-pixel space.
 *
 * Geometry interpretation:
 *   - Point/dot glyph: only x, y (+ optional r) — circle hit-test.
 *   - Line segment: x, y, x2, y2 — segment-distance hit-test.
 *   - Rect/band: x, y, x2, y2 — axis-aligned rect hit-test (x..x2, y..y2).
 * The kind determines which interpretation applies (see `hitTest`).
 */
export interface HitRegion {
  /** Primary anchor X (CSS px, canvas-relative). */
  x: number;
  /** Primary anchor Y (CSS px, canvas-relative). */
  y: number;
  /** Hit radius for dot kinds (CSS px). Defaults to DOT_RADIUS_PX. */
  r?: number;
  /** Secondary X for line/rect kinds (CSS px). */
  x2?: number;
  /** Secondary Y for line/rect kinds (CSS px). */
  y2?: number;
  kind: HitRegionKind;
  /** Renderer-owned data the info panel will display. Opaque to the substrate. */
  payload: unknown;
}

/** Result of a mousemove query against the last completed draw. */
export interface HitResult {
  /** The single closest region (wins for default display). */
  nearest: HitRegion;
  /**
   * All regions within tolerance at the query point, nearest-first and
   * INCLUDING `nearest` at index 0. A later step cycles ‹N/M› over these.
   */
  coincident: HitRegion[];
  /** Pointer position that produced this result (CSS px, canvas-relative). */
  clientX: number;
  clientY: number;
}

/** Default circle hit radius for dot/glyph regions (CSS px). */
export const DOT_RADIUS_PX = 10;
/** Segment-distance tolerance for line regions (CSS px). */
export const LINE_TOLERANCE_PX = 8;

/** Kinds whose geometry is a line segment (segment-distance hit-test). */
const LINE_KINDS: ReadonlySet<HitRegionKind> = new Set<HitRegionKind>([
  'trend',
]);

/** Kinds whose geometry is an axis-aligned rect / vertical band. */
const RECT_KINDS: ReadonlySet<HitRegionKind> = new Set<HitRegionKind>([
  'timelineRange',
  'timelineVline',
  'rangeEdge',
]);

/** Distance from point (px,py) to segment (x1,y1)-(x2,y2). */
export function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * Distance (CSS px) from the query point to a region, by kind geometry.
 * Returns `Infinity` when the point is outside the region's tolerance band so
 * the caller can treat "no hit" uniformly.
 *
 * - rect kinds: 0 when inside the band, else Infinity (no soft falloff — bands
 *   are large targets and a soft edge would steal hits from dots/lines on top).
 * - line kinds: segment distance, gated by LINE_TOLERANCE_PX.
 * - everything else: circle distance, gated by (r ?? DOT_RADIUS_PX).
 */
export function distanceToRegion(region: HitRegion, px: number, py: number): number {
  if (RECT_KINDS.has(region.kind) && region.x2 !== undefined) {
    const left = Math.min(region.x, region.x2);
    const right = Math.max(region.x, region.x2);
    // Vertical band: when y2 is set, also bound vertically; else full height.
    const insideX = px >= left && px <= right;
    let insideY = true;
    if (region.y2 !== undefined) {
      const top = Math.min(region.y, region.y2);
      const bot = Math.max(region.y, region.y2);
      insideY = py >= top && py <= bot;
    }
    return insideX && insideY ? 0 : Infinity;
  }

  if (LINE_KINDS.has(region.kind) && region.x2 !== undefined && region.y2 !== undefined) {
    const d = distToSegment(px, py, region.x, region.y, region.x2, region.y2);
    return d <= LINE_TOLERANCE_PX ? d : Infinity;
  }

  // Dot / glyph: circle hit-test.
  const r = region.r ?? DOT_RADIUS_PX;
  const d = Math.hypot(px - region.x, py - region.y);
  return d <= r ? d : Infinity;
}

/**
 * Query the registry at (px, py) in CSS px. O(regions).
 *
 * Returns the nearest hit plus all coincident hits (nearest-first), or null
 * when nothing is within tolerance. Coincident = every region whose distance is
 * also a hit AND within COINCIDENT_SLACK_PX of the nearest distance — this lets
 * a stack of overlapping glyphs (e.g. a mark dot on a trend line) all surface in
 * the ‹N/M› cycler without dragging in far-away regions.
 */
const COINCIDENT_SLACK_PX = 6;

export function hitTest(
  regions: readonly HitRegion[],
  px: number,
  py: number,
): HitResult | null {
  // Single pass: collect every hit (within tolerance) as {region, dist}.
  const hits: { region: HitRegion; dist: number }[] = [];
  for (const region of regions) {
    const d = distanceToRegion(region, px, py);
    if (d === Infinity) continue;
    hits.push({ region, dist: d });
  }

  // Early-out: nothing within tolerance.
  if (hits.length === 0) return null;

  // Sort by distance → nearest is first; coincident = those within slack of it.
  hits.sort((a, b) => a.dist - b.dist);
  const nearestDist = hits[0]!.dist;
  const coincident: HitRegion[] = [];
  for (const h of hits) {
    if (h.dist > nearestDist + COINCIDENT_SLACK_PX) break;
    coincident.push(h.region);
  }

  return { nearest: hits[0]!.region, coincident, clientX: px, clientY: py };
}

/**
 * Stable identity key for a hit result, so the consumer can avoid re-render
 * storms: state only updates when this key changes between mousemove events.
 * Encodes the nearest region's kind + anchor and the coincident count.
 */
export function hitResultKey(result: HitResult | null): string {
  if (!result) return '';
  const n = result.nearest;
  return `${n.kind}:${Math.round(n.x)}:${Math.round(n.y)}:${result.coincident.length}`;
}
