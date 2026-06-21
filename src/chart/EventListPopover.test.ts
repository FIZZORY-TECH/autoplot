/**
 * src/chart/EventListPopover.test.ts — S6 id-resolution unit tests.
 *
 * Covers the pure `resolveEventIds` helper:
 *   - research id → full row data (label/ts/content/source).
 *   - degraded timeline id → row with NO content/source (timeline source).
 *   - newest-first ordering by ts (descending).
 *   - loading (no source present) vs error (source present, element missing).
 */

import { describe, it, expect } from 'vitest';
import { resolveEventIds } from './EventListPopover';
import { eventMarkId } from './layers/GenericResearchLayer';
import { timelineEventId } from './layers/TimelineEventsLayer';

describe('resolveEventIds', () => {
  const researchOverlays = {
    ov1: {
      elements: [
        {
          type: 'event_mark',
          kind: 'pin',
          ts: 1000,
          label: 'Older research',
          content: 'Some long body of content',
          source_url: 'https://example.com/a',
          source_name: 'example.com',
        },
        {
          type: 'event_mark',
          kind: 'pin',
          ts: 3000,
          label: 'Newer research',
          content: 'Newer body',
        },
      ],
    },
  };

  const timelineLayers = {
    lyr1: {
      events: [{ ts: 2000, label: 'Mid timeline', kind: 'pin' }],
    },
  };

  it('resolves a research id to full row data', () => {
    const { events, loading } = resolveEventIds(
      [eventMarkId('ov1', 0)],
      researchOverlays,
      timelineLayers,
    );
    expect(loading).toBe(false);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.source).toBe('research');
    if (ev.source === 'research') {
      expect(ev.label).toBe('Older research');
      expect(ev.ts).toBe(1000);
      expect(ev.content).toBe('Some long body of content');
      expect(ev.sourceUrl).toBe('https://example.com/a');
      expect(ev.sourceName).toBe('example.com');
    }
  });

  it('resolves a timeline id as a DEGRADED row (no content/source)', () => {
    const { events } = resolveEventIds(
      [timelineEventId('lyr1', 0)],
      researchOverlays,
      timelineLayers,
    );
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.source).toBe('timeline');
    if (ev.source === 'timeline') {
      expect(ev.label).toBe('Mid timeline');
      expect(ev.ts).toBe(2000);
      // No content/source fields exist on the degraded shape.
      expect('content' in ev).toBe(false);
      expect('sourceUrl' in ev).toBe(false);
    }
  });

  it('orders mixed events newest-first (descending ts)', () => {
    const { events } = resolveEventIds(
      [eventMarkId('ov1', 0), timelineEventId('lyr1', 0), eventMarkId('ov1', 1)],
      researchOverlays,
      timelineLayers,
    );
    expect(events.map((e) => (e.source === 'error' ? -1 : e.ts))).toEqual([
      3000, 2000, 1000,
    ]);
  });

  it('flags loading when no referenced source is present yet', () => {
    const { events, loading } = resolveEventIds([eventMarkId('absent', 0)], {}, {});
    expect(loading).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]!.source).toBe('error');
  });

  it('flags a deleted element as an error (not loading) when its overlay is present', () => {
    const { events, loading } = resolveEventIds(
      [eventMarkId('ov1', 0), eventMarkId('ov1', 99)],
      researchOverlays,
      timelineLayers,
    );
    expect(loading).toBe(false);
    // ov1[0] resolves; ov1[99] is out of range → error.
    expect(events.some((e) => e.source === 'error')).toBe(true);
    expect(events.some((e) => e.source === 'research')).toBe(true);
  });
});
