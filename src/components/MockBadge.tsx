/**
 * src/components/MockBadge.tsx — visible "MOCK" status pill.
 *
 * Surfaces silent mock-data fallbacks so the user doesn't read mock prices off
 * the chart thinking they're live. Renders only when `subscribeMockStatus`
 * reports `active` (forced via `localStorage.use-mock-provider`, or set by the
 * provider registry's fallback path).
 */

import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { setMockActive, subscribeMockStatus, type MockStatus } from '../data/mockStatus';
import { isMockForced } from '../data/providerRegistry';

const containerStyle: CSSProperties = {
  position: 'fixed',
  top: 16,
  right: 16,
  zIndex: 'var(--z-banner)',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 10px',
  borderRadius: 'var(--r-pill)',
  // --warn carries the semantic "attention, not error" weight per tokens.css §01.
  color: 'var(--warn)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-mono-sm)',
  letterSpacing: 'var(--tracking-mono-sm)',
  textTransform: 'uppercase',
  fontVariantNumeric: 'tabular-nums',
  // Layered: elevation only. No bright stroke (Principle 04).
  boxShadow: 'var(--shadow-glass)',
  transition: 'opacity var(--t-fast) var(--ease)',
  cursor: 'help',
  userSelect: 'none',
};

const dotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: 'var(--warn)',
};

export function MockBadge() {
  const [status, setStatus] = useState<MockStatus>({ active: false });

  // Subscribe to mock-status changes from the data layer.
  useEffect(() => subscribeMockStatus(setStatus), []);

  // Reflect a pre-existing `use-mock-provider` flag immediately on mount —
  // before the first `getProvider(...)` call has had a chance to broadcast.
  useEffect(() => {
    if (isMockForced()) {
      setMockActive(true, 'use-mock-provider flag is set in localStorage');
    }
  }, []);

  if (!status.active) return null;

  return (
    <div
      className="glass-strong popover-enter"
      style={containerStyle}
      role="status"
      aria-live="polite"
      title={status.reason ?? 'Showing mock market data — not live prices.'}
    >
      <span style={dotStyle} aria-hidden="true" />
      <span>MOCK</span>
    </div>
  );
}

export default MockBadge;
