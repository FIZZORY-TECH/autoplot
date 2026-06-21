/**
 * src/components/DevReseedButton.tsx — DEV-ONLY control to reseed the
 * event/series mock fixture against the current bars.
 *
 * ⚠️  PRODUCTION SAFETY ⚠️
 * The single call site in AppShell renders <DevReseedButton/> only inside an
 * `import.meta.env.DEV &&` guard, so `vite build` drops the element AND this
 * module (it becomes unreferenced). The component also self-gates on
 * `import.meta.env.DEV` and returns null, as a belt-and-braces second guard.
 *
 * The fixture module is loaded lazily (dynamic import) on click, so even the
 * fixture code never ships to prod.
 */

import { useCallback, type CSSProperties } from 'react';
import type { Bar, Tf } from '../data/MarketDataProvider';

interface Props {
  bars: Bar[];
  sym: string;
  tf: Tf;
}

const wrapStyle: CSSProperties = {
  position: 'fixed',
  bottom: 12,
  left: 12,
  zIndex: 'var(--z-banner)',
};

export function DevReseedButton({ bars, sym, tf }: Props) {
  const onClick = useCallback(() => {
    void import('../ai/devEventFixtures').then(({ seedDevEventFixtures }) => {
      const ok = seedDevEventFixtures(bars, sym, tf, { bumpNonce: true });
      if (!ok) {
        // eslint-disable-next-line no-console
        console.warn('[DevReseedButton] no bars to anchor to — load a chart first');
      }
    });
  }, [bars, sym, tf]);

  // Belt-and-braces second guard (the call site already gates on DEV).
  if (!import.meta.env.DEV) return null;

  return (
    <div style={wrapStyle}>
      <button
        type="button"
        className="dev-reseed-pill"
        onClick={onClick}
        aria-label="Reseed dev event fixture against the current bars"
        title="DEV: reseed mock events + series against the current bars"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <polyline points="21 3 21 9 15 9" />
        </svg>
        <span>Reseed events</span>
      </button>
    </div>
  );
}

export default DevReseedButton;
