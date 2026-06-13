// ============ Chrome: activity rails, watchlist orbs, dock, palette, mark composer, indicator panel ============
const { useState, useEffect, useRef, useMemo, useCallback } = React;

/* ---------- Activity rails (ADR-0011) ----------
   Two always-visible ~48px icon rails, one per window edge. Each rail toggles
   one-per-side docked drawer. Icons reuse .dock-btn (glow on .active — never a
   solid border). Left rail: Watchlist only (Strategy opens via MCP bridge,
   not a rail toggle). Right rail: Terminal, Portfolio, Indicator, Settings.
   Terminal is open by default (right rail shows --docked glass). */
const RAIL_ICONS = {
  watchlist: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>,
  strategy:  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>,
  terminal:  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>,
  portfolio: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><line x1="12" y1="12" x2="12" y2="12.01"/></svg>,
  indicator: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><polyline points="7 14 11 9 14 12 19 6"/></svg>,
  settings:  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
};
const RAIL_META = {
  watchlist: { label: 'Watchlist' },
  strategy:  { label: 'Strategy' },
  terminal:  { label: 'Terminal', kbd: '⌘`' },
  portfolio: { label: 'Portfolio', kbd: '⌘P' },
  indicator: { label: 'Indicators', kbd: 'D' },
  settings:  { label: 'Settings', kbd: '⌘,' },
};
/* Left rail has Watchlist only — Strategy is not a rail toggle; it opens via
   the MCP bridge when an agent emits a strategy artifact. */
const RAIL_ORDER = { left: ['watchlist'], right: ['terminal', 'portfolio', 'indicator', 'settings'] };

function ActivityBar({ side, openId, onToggle }) {
  /* --docked: drawer on this side is open — rail merges into one glass surface.
     In prototype the right rail starts docked (Terminal open by default). */
  const docked = openId != null;
  return (
    <div className={`activity-bar ${side}${docked ? ' activity-bar--docked' : ''}`} role="toolbar" aria-orientation="vertical" aria-label={`${side} dock`}>
      {RAIL_ORDER[side].map(id => {
        const meta = RAIL_META[id];
        const open = openId === id;
        return (
          <button
            key={id}
            className={`dock-btn ${open ? 'active' : ''}`}
            aria-label={meta.label}
            aria-pressed={open}
            title={meta.kbd ? `${meta.label} (${meta.kbd})` : meta.label}
            onClick={() => onToggle(id)}
          >
            {RAIL_ICONS[id]}
            <span className="glabel">{meta.label}{meta.kbd ? `  ${meta.kbd}` : ''}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ---------- DockDrawer (ADR-0011) ----------
   The single reusable glass shell every dock panel is wrapped in. It sits flush
   against its rail, fills the reserved inset, and equals the chart's inset on its
   side. Width drives the side's reserve var so the chart insets in lockstep. The
   shell owns the slide motion; the wrapped panel just renders content. */
function DockDrawer({ side, open, width, label, children }) {
  if (!open) return null;
  return (
    <div className={`dock-drawer ${side}`} role="dialog" aria-label={label} style={{ width }}>
      {children}
    </div>
  );
}

/* ---------- Watchlist ---------- */
function Watchlist({ groups, setGroups, assetMap, activeSym, onPick, candlesBySym }) {
  const [dragSym, setDragSym] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [editing, setEditing] = useState(null);

  const onDragStart = (sym) => (e) => {
    setDragSym(sym);
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', sym); } catch {}
  };
  const onDragEnd = () => { setDragSym(null); setDropTarget(null); };
  const onDragOver = (gid) => (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget(gid);
  };
  const onDrop = (gid) => (e) => {
    e.preventDefault();
    if (!dragSym) return;
    setGroups(prev => prev.map(g => ({
      ...g,
      syms: g.id === gid ? Array.from(new Set([...g.syms, dragSym])) : g.syms.filter(s => s !== dragSym),
    })));
    setDropTarget(null);
    setDragSym(null);
  };

  const addGroup = () => {
    const id = 'g' + Math.random().toString(36).slice(2, 7);
    setGroups(prev => [...prev, { id, label: 'NEW', syms: [] }]);
    setTimeout(() => setEditing(id), 50);
  };

  return (
    <div className="watchlist">
      {groups.map(g => (
        <div
          key={g.id}
          className={`group ${dropTarget === g.id ? 'drop-target' : ''}`}
          onDragOver={onDragOver(g.id)}
          onDrop={onDrop(g.id)}
          onDragLeave={() => setDropTarget(t => t === g.id ? null : t)}
        >
          {editing === g.id ? (
            <input
              autoFocus
              defaultValue={g.label}
              className="glabel-edit"
              onBlur={(e) => {
                const v = e.target.value.trim().slice(0, 14) || g.label;
                setGroups(prev => prev.map(x => x.id === g.id ? { ...x, label: v } : x));
                setEditing(null);
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setEditing(null); }}
            />
          ) : (
            <span className="glabel" onDoubleClick={() => setEditing(g.id)}>{g.label}</span>
          )}
          {g.syms.map(sym => {
            const a = assetMap[sym];
            if (!a) return null;
            const cs = candlesBySym[sym];
            const last = cs?.[cs.length - 1];
            const prev = cs?.[cs.length - 2];
            const chg = last && prev ? (last.c - prev.c) / prev.c : 0;
            return (
              <div
                key={sym}
                draggable
                onDragStart={onDragStart(sym)}
                onDragEnd={onDragEnd}
                className={`orb ${activeSym === sym ? 'active' : ''} ${dragSym === sym ? 'dragging' : ''}`}
                style={{ '--o-color': a.color }}
                onClick={() => onPick(sym)}
                title={a.name}
              >
                {activeSym === sym && <span className="heartbeat" />}
                <span className="ticker">{sym.slice(0, 3)}</span>
                <div className="tooltip">
                  <span className="name">{a.name}</span>
                  <span className="last">{window.TradingData.fmtPrice(last?.c ?? a.seed)}</span>
                  <span className="chg" style={{ color: chg >= 0 ? 'oklch(0.78 0.16 150)' : 'oklch(0.70 0.20 25)' }}>
                    {window.TradingData.fmtPct(chg)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      ))}
      <button className="add-group" onClick={addGroup} title="Add focus group">
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
      </button>
    </div>
  );
}

/* ---------- Dock ---------- */
const CHART_TYPES = [
  { id: 'candles',  label: 'Candles',     icon: <CandleIcon /> },
  { id: 'heikin',   label: 'Heikin Ashi', icon: <HeikinIcon /> },
  { id: 'bars',     label: 'OHLC Bars',   icon: <BarsIcon /> },
  { id: 'line',     label: 'Line',        icon: <LineIcon /> },
  { id: 'area',     label: 'Area',        icon: <AreaIcon /> },
  { id: 'mountain', label: 'Pulse',       icon: <PulseIcon /> },
];
const TFS = ['5m','15m','1h','4h','1d','1w'];

function Dock({ chartType, setChartType, tf, setTf, tool, setTool }) {
  const tfRef = useRef(null);
  const tfIdx = TFS.indexOf(tf);
  return (
    <div className="dock">
      <div className="dock-group">
        {CHART_TYPES.map(t => (
          <button
            key={t.id}
            className={`dock-btn ${chartType === t.id ? 'active' : ''}`}
            onClick={() => setChartType(t.id)}
          >
            {t.icon}
            <span className="glabel">{t.label}</span>
          </button>
        ))}
      </div>

      <div className="tf-scrubber" ref={tfRef}>
        <span className="tf-pill" style={{ transform: `translateX(${tfIdx * 36}px)` }} />
        {TFS.map(t => (
          <button key={t} className={`tf-tick ${tf === t ? 'active' : ''}`} onClick={() => setTf(t)}>{t}</button>
        ))}
      </div>

      <div className="dock-group">
        <button className={`dock-btn ${tool === 'range' ? 'active' : ''}`} onClick={() => setTool(tool === 'range' ? null : 'range')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
            <path d="M3 4v8M13 4v8M3 8h10"/>
          </svg>
          <span className="glabel">Scope range</span>
        </button>
        <button className={`dock-btn ${tool === 'mark' ? 'active' : ''}`} onClick={() => setTool(tool === 'mark' ? null : 'mark')}>
          <MarkIcon />
          <span className="glabel">Price mark</span>
        </button>
        <button className={`dock-btn ${tool === 'comment' ? 'active' : ''}`} onClick={() => setTool(tool === 'comment' ? null : 'comment')}>
          <CommentIcon />
          <span className="glabel">Comment</span>
        </button>
      </div>
    </div>
  );
}

/* ---------- Top-right actions ----------
   Reset + Switch-asset only. The Overlays trigger moved to the right activity
   rail as the Indicator drawer icon (ADR-0011). */
function Actions({ onPalette, onResetView }) {
  return (
    <div className="actions">
      <button className="action-btn" onClick={onResetView} title="Reset view">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <path d="M3 9a6 6 0 1 0 1.8-4.3"/><path d="M3 3v3.5h3.5"/>
        </svg>
        <span className="kbd">R</span>
      </button>
      <button className="action-btn" onClick={onPalette} title="Switch asset">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <circle cx="8" cy="8" r="5"/><path d="M15 15l-3-3"/>
        </svg>
        <span className="kbd">⌘ K</span>
      </button>
    </div>
  );
}

/* ---------- Command palette ---------- */
function Palette({ assets, candlesBySym, onPick, onClose }) {
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return assets;
    return assets.filter(a =>
      a.sym.toLowerCase().includes(qq) ||
      a.name.toLowerCase().includes(qq) ||
      a.cls.toLowerCase().includes(qq)
    );
  }, [q, assets]);

  useEffect(() => { setCursor(0); }, [q]);

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(filtered.length - 1, c + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(0, c - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[cursor]) onPick(filtered[cursor].sym); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  return (
    <div className="scrim" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div className="search">
          <span className="icon">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <circle cx="7" cy="7" r="4.5"/><path d="M14 14l-3.5-3.5"/>
            </svg>
          </span>
          <input
            ref={inputRef}
            placeholder="Search asset · BTC · NVDA · crypto · stock"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
          />
          <span className="esc">ESC</span>
        </div>
        <div className="results">
          {filtered.map((a, i) => {
            const cs = candlesBySym[a.sym];
            const last = cs?.[cs.length - 1];
            const first = cs?.[Math.max(0, cs.length - 24)];
            const chg = last && first ? (last.c - first.c) / first.c : 0;
            const color = chg >= 0 ? 'oklch(0.78 0.16 150)' : 'oklch(0.70 0.20 25)';
            return (
              <div
                key={a.sym}
                className={`row ${i === cursor ? 'cursor' : ''}`}
                style={{ '--o-color': a.color, '--row-color': color }}
                onMouseEnter={() => setCursor(i)}
                onClick={() => onPick(a.sym)}
              >
                <div className="o" />
                <div className="sym">{a.sym}</div>
                <div className="nm">{a.name} · <span style={{ color: 'var(--ink-3)' }}>{a.cls}</span></div>
                <div className="px">{window.TradingData.fmtPrice(last?.c ?? a.seed)}</div>
                <div className="ch">{window.TradingData.fmtPct(chg)}</div>
              </div>
            );
          })}
        </div>
        <div className="footer">
          <span><span className="k">↑↓</span> navigate</span>
          <span><span className="k">↵</span> open</span>
          <span><span className="k">ESC</span> close</span>
        </div>
      </div>
    </div>
  );
}

/* ---------- Indicator panel (docked drawer content; was OverlaysPanel) ----------
   The toggle-panel UI is renamed Overlays → Indicators (ADR-0011). PANEL UI
   rename only — the chart-engine overlay vocabulary is a different concept and
   is unchanged. Rendered as the body of the right-rail Indicator drawer; the
   .dock-drawer shell owns the glass + slide motion. */
const SAMPLE_CSV = `# paste numbers, comma or newline, aligned to last bars
108.2, 109.4, 110.1, 109.8, 111.2, 112.6, 114.0, 113.3,
112.7, 113.9, 115.2, 116.4, 117.1, 116.0, 117.8, 119.2`;

const INDICATOR_ITEMS = [
  { id: 'ma20', label: 'Moving avg', desc: 'SMA 20', color: 'oklch(0.85 0.14 80)' },
  { id: 'ma50', label: 'Moving avg', desc: 'SMA 50', color: 'oklch(0.78 0.14 280)' },
  { id: 'bb',   label: 'Bollinger',  desc: '20 · 2σ', color: 'rgba(180,200,230,0.6)' },
];

function IndicatorPanel({ indicatorFlags, setIndicatorFlags, customText, setCustomText, onApplyCustom, onClose }) {
  return (
    <div className="indicator-panel">
      <div className="heading">
        <span>Indicators · Custom data</span>
        <button className="x" onClick={onClose} title="Close">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
        </button>
      </div>
      {INDICATOR_ITEMS.map(it => (
        <div key={it.id} className="toggle-row" onClick={() => setIndicatorFlags(s => ({ ...s, [it.id]: !s[it.id] }))} style={{ '--ov-color': it.color }}>
          <div className="left">
            <span className="swatch" />
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span className="label">{it.label}</span>
              <span className="desc">{it.desc}</span>
            </div>
          </div>
          <span className={`toggle ${indicatorFlags[it.id] ? 'on' : ''}`} />
        </div>
      ))}

      <div className="heading" style={{ marginTop: 4 }}>
        <span>Your data</span>
        <span style={{ color: 'var(--ink-4)', fontSize: 9 }}>aligned to right</span>
      </div>
      <textarea
        className="csv"
        placeholder={SAMPLE_CSV}
        value={customText}
        onChange={(e) => setCustomText(e.target.value)}
      />
      <button className="apply" onClick={onApplyCustom}>Plot ↵</button>
    </div>
  );
}

/* ---------- Mark composer ---------- */
const MARK_COLORS = [
  'oklch(0.82 0.14 215)',
  'oklch(0.78 0.16 150)',
  'oklch(0.70 0.20 25)',
  'oklch(0.85 0.16 80)',
  'oklch(0.78 0.18 320)',
];
function MarkComposer({ at, defaultPrice, onSave, onCancel }) {
  const [color, setColor] = useState(MARK_COLORS[0]);
  const [note, setNote] = useState('');
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="mark-composer" style={{ left: at.x, top: at.y }}>
      <div className="row1">
        <span>Mark @ {window.TradingData.fmtPrice(defaultPrice)}</span>
        <div className="swatches">
          {MARK_COLORS.map(c => (
            <span
              key={c}
              className={`sw ${color === c ? 'selected' : ''}`}
              style={{ '--c': c }}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
      </div>
      <textarea
        ref={ref}
        placeholder="Note (optional) — entry, target, why…"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onSave({ color, note }); }
          else if (e.key === 'Escape') onCancel();
        }}
      />
      <div className="actions-row">
        <button className="cancel" onClick={onCancel}>Cancel</button>
        <button className="save" onClick={() => onSave({ color, note })}>Save  ⌘↵</button>
      </div>
    </div>
  );
}

/* ---------- icons ---------- */
function CandleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <line x1="5" y1="2" x2="5" y2="14" stroke="currentColor" strokeWidth="1"/>
      <rect x="3" y="5" width="4" height="6" fill="currentColor"/>
      <line x1="11" y1="3" x2="11" y2="13" stroke="currentColor" strokeWidth="1"/>
      <rect x="9" y="6" width="4" height="4" fill="none" stroke="currentColor" strokeWidth="1.2"/>
    </svg>
  );
}
function HeikinIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <line x1="4" y1="3" x2="4" y2="13" stroke="currentColor" strokeWidth="1"/>
      <rect x="2.5" y="5" width="3" height="6" fill="currentColor" opacity="0.6"/>
      <line x1="8" y1="2" x2="8" y2="14" stroke="currentColor" strokeWidth="1"/>
      <rect x="6.5" y="4" width="3" height="7" fill="currentColor" opacity="0.85"/>
      <line x1="12" y1="3" x2="12" y2="13" stroke="currentColor" strokeWidth="1"/>
      <rect x="10.5" y="3.5" width="3" height="6" fill="currentColor"/>
    </svg>
  );
}
function BarsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
      <line x1="4" y1="3" x2="4" y2="12"/><line x1="2.5" y1="5" x2="4" y2="5"/><line x1="4" y1="10" x2="5.5" y2="10"/>
      <line x1="11" y1="2" x2="11" y2="13"/><line x1="9.5" y1="4" x2="11" y2="4"/><line x1="11" y1="11" x2="12.5" y2="11"/>
    </svg>
  );
}
function LineIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M2 11l3-4 3 2 3-5 3 3"/></svg>;
}
function AreaIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M2 11l3-4 3 2 3-5 3 3v6H2z" fill="currentColor" opacity="0.25"/>
      <path d="M2 11l3-4 3 2 3-5 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
  );
}
function PulseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <line x1="3" y1="11" x2="3" y2="9"/><line x1="5" y1="11" x2="5" y2="6"/><line x1="7" y1="11" x2="7" y2="8"/>
      <line x1="9" y1="11" x2="9" y2="4"/><line x1="11" y1="11" x2="11" y2="7"/><line x1="13" y1="11" x2="13" y2="9"/>
    </svg>
  );
}
function MarkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
      <path d="M2 8h6"/><path d="M11 8h3"/>
      <circle cx="9.5" cy="8" r="1.6" fill="currentColor"/>
    </svg>
  );
}
function CommentIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
      <path d="M3 4h10v6H7l-3 2.5V10H3z"/>
    </svg>
  );
}

window.Chrome = { ActivityBar, DockDrawer, Watchlist, Dock, Actions, Palette, IndicatorPanel, MarkComposer };
