/**
 * src/chart/primaryReadout.test.ts — the precedence-ladder authority.
 *
 * Locks the single "which readout is primary right now" decision used to keep
 * the floating chart panels mutually exclusive (UX-clutter fix). Highest rung
 * wins: popover > event-hover > overlay-hover > price.
 */

import { describe, it, expect } from 'vitest';
import { derivePrimaryReadout } from '../stores/useOverlayHitStore';
import type { HitRegion, HitResult, HitRegionKind } from './hitRegions';

function hitOf(kind: HitRegionKind): HitResult {
  const region: HitRegion = { x: 100, y: 100, kind, payload: {} };
  return { nearest: region, coincident: [region], clientX: 100, clientY: 100 };
}

describe('derivePrimaryReadout — precedence ladder', () => {
  it('rung 1: popover open wins over everything (even an event hover)', () => {
    expect(derivePrimaryReadout(hitOf('research'), true)).toBe('popover');
    expect(derivePrimaryReadout(hitOf('mark'), true)).toBe('popover');
    expect(derivePrimaryReadout(null, true)).toBe('popover');
  });

  it("rung 2: hovering an event hotspot → 'event' (research + timelinePin)", () => {
    expect(derivePrimaryReadout(hitOf('research'), false)).toBe('event');
    expect(derivePrimaryReadout(hitOf('timelinePin'), false)).toBe('event');
  });

  it("rung 3: hovering a non-event mark/indicator → 'overlay'", () => {
    expect(derivePrimaryReadout(hitOf('mark'), false)).toBe('overlay');
    expect(derivePrimaryReadout(hitOf('indicatorLast'), false)).toBe('overlay');
    expect(derivePrimaryReadout(hitOf('trend'), false)).toBe('overlay');
    // A non-clustered timeline kind (vline/range) is NOT an event-popover rung.
    expect(derivePrimaryReadout(hitOf('timelineVline'), false)).toBe('overlay');
  });

  it("rung 4: nothing hovered, no popover → 'price' (the default)", () => {
    expect(derivePrimaryReadout(null, false)).toBe('price');
  });
});
