/**
 * src/chrome/MarkComposer.tsx — Floating glass card for authoring marks.
 *
 * Behavior (mirrors `app-design/project/chrome.jsx` MarkComposer):
 *   - Opens at the click position when activeTool is 'mark' or 'comment'.
 *   - 5 color swatches drawn from tokens.css (accent / up / down / warn / violet).
 *   - When mode === 'comment', renders a textarea for note entry.
 *   - ⌘+Enter (Mac) / Ctrl+Enter (Win/Linux) → save.
 *   - Esc → cancel without saving.
 *   - Click outside → cancel (handled by host via onCancel binding).
 *
 * Persistence is the host's responsibility — this component is presentational.
 * The host receives a typed `onSave({ color, note })` payload and calls
 * `dbMarksInsert` itself, then refreshes the marks list.
 */

import { useEffect, useRef, useState } from 'react';

/** The 5 swatch tokens. Verbatim oklch values from tokens.css §accent palette. */
export const MARK_COLORS = [
  'oklch(0.82 0.14 215)', // --accent (cyan)
  'oklch(0.78 0.16 150)', // --up    (green)
  'oklch(0.70 0.20 25)',  // --down  (red)
  'oklch(0.85 0.16 80)',  // --warn  (amber)
  'oklch(0.78 0.18 320)', // --violet
] as const;

export type MarkColor = (typeof MARK_COLORS)[number];

/** Composer mode — 'mark' = no textarea, 'comment' = textarea. */
export type ComposerMode = 'mark' | 'comment';

export interface MarkComposerProps {
  /** Anchor position in CSS px relative to the chart wrapper (or viewport). */
  at: { x: number; y: number };
  /** Price at click — shown read-only as the binding header. */
  price: number;
  /** Mode toggles textarea visibility. */
  mode: ComposerMode;
  /** Save handler; host calls dbMarksInsert + refreshes the marks list. */
  onSave: (payload: { color: string; note: string | null }) => void;
  /** Cancel handler — composer closes without persisting. */
  onCancel: () => void;
  /** Optional formatter for the price header (defaults to fmtPrice). */
  formatPrice?: (n: number) => string;
  /** Pre-selected color swatch (for edit mode). Defaults to first swatch. */
  initialColor?: string;
  /** Pre-filled note text (for edit mode). */
  initialNote?: string;
}

const COMPOSER_W = 280;
const COMPOSER_OFFSET_X = 12; // gap from cursor

export function MarkComposer({
  at,
  price,
  mode,
  onSave,
  onCancel,
  formatPrice,
  initialColor,
  initialNote,
}: MarkComposerProps) {
  const [color, setColor] = useState<string>(initialColor ?? MARK_COLORS[0]);
  const [note, setNote] = useState(initialNote ?? '');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Focus the textarea on mount (Comment mode), or the card itself (Mark mode)
  // so Esc/⌘+Enter still fire when no input has focus.
  useEffect(() => {
    if (mode === 'comment') {
      textareaRef.current?.focus();
    } else {
      cardRef.current?.focus();
    }
  }, [mode]);

  // ⌘+Enter / Ctrl+Enter to save — bound at the card so the shortcut works
  // whether or not the textarea has focus.
  // Esc-to-cancel is handled by the global keyboard dispatcher
  // (src/stores/keyboard.ts, P2.7) via the composerOpen → resetComposer path.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      doSave();
    }
  };

  const doSave = () => {
    const trimmed = note.trim();
    onSave({
      color,
      // Mark mode never has a note. Comment mode with empty text is still a Mark.
      note: mode === 'comment' && trimmed.length > 0 ? trimmed : null,
    });
  };

  // Clamp popover horizontally within the viewport.
  const left = Math.max(8, Math.min(window.innerWidth - COMPOSER_W - 8, at.x + COMPOSER_OFFSET_X));
  const top = Math.max(8, at.y - 8);

  const fmt = formatPrice ?? defaultFmt;

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={mode === 'comment' ? 'Comment composer' : 'Mark composer'}
      tabIndex={-1}
      className="glass-strong overlay-enter"
      onKeyDown={onKeyDown}
      style={{
        position: 'absolute',
        left,
        top,
        width: COMPOSER_W,
        padding: 'var(--sp-8)',
        borderRadius: 'var(--r-14)',
        zIndex: 'var(--z-chart-panel)',
        outline: 'none',
        boxShadow: '0 18px 40px rgba(0,0,0,0.55)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sp-8)',
        // over-content fill — see --surface-overlay in tokens.css (ADR-0012)
        background: 'var(--surface-overlay)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span
          style={{
            fontSize: 11,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--ink-3, #7B8290)',
          }}
        >
          {mode === 'comment' ? 'Comment' : 'Mark'} @ {fmt(price)}
        </span>
        <div role="radiogroup" aria-label="Mark color" style={{ display: 'flex', gap: 'var(--sp-6)' }}>
          {MARK_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={`Color ${c}`}
              onClick={() => setColor(c)}
              style={{
                width: 16,
                height: 16,
                borderRadius: '50%',
                background: c,
                border:
                  color === c
                    ? '2px solid rgba(255,255,255,0.85)'
                    : '1px solid rgba(255,255,255,0.18)',
                padding: 0,
                cursor: 'pointer',
                outline: 'none',
              }}
            />
          ))}
        </div>
      </div>

      {mode === 'comment' ? (
        <textarea
          ref={textareaRef}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note — entry, target, why…"
          rows={3}
          style={{
            resize: 'vertical',
            width: '100%',
            padding: 8,
            borderRadius: 'var(--r-8)',
            border: '1px solid rgba(255,255,255,0.10)',
            background: 'rgba(0,0,0,0.30)',
            color: 'var(--ink-1, #E6EAF2)',
            fontSize: 13,
            fontFamily: 'inherit',
            outline: 'none',
          }}
        />
      ) : null}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <button
          type="button"
          onClick={onCancel}
          style={{
            padding: 'var(--sp-6) var(--sp-8)',
            borderRadius: 'var(--r-8)',
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.12)',
            color: 'var(--ink-2, #A7B0BD)',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={doSave}
          style={{
            padding: 'var(--sp-6) var(--sp-8)',
            borderRadius: 'var(--r-8)',
            background: color,
            border: '1px solid rgba(255,255,255,0.16)',
            color: 'rgba(10,14,20,0.92)',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Save&nbsp;<span style={{ opacity: 0.7 }}>⌘↵</span>
        </button>
      </div>
    </div>
  );
}

/** Tiny default formatter so the composer can be used without engine import. */
function defaultFmt(n: number): string {
  if (!isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toFixed(3);
  return n.toFixed(5);
}

export default MarkComposer;
