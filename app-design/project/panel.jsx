// ============ Floating asset panel + add modal ============
const { useState, useEffect, useRef, useMemo, useCallback } = React;

function MiniSpark({ data, color, w = 56, h = 18 }) {
  if (!data || data.length < 2) return null;
  let lo = Infinity, hi = -Infinity;
  for (const v of data) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const r = hi - lo || 1;
  const pts = data.map((v, i) => `${(i/(data.length-1))*w},${h - ((v - lo)/r)*h}`).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" opacity="0.85"/>
    </svg>
  );
}

function AssetPanel({
  added, setAdded, assetMap, providers, allAssets,
  activeSym, onPick, candlesBySym,
  collapsed, setCollapsed,
  position, setPosition,
}) {
  const [q, setQ] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const dragRef = useRef(null);
  const panelRef = useRef(null);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return added;
    return added.filter(s => {
      const a = assetMap[s];
      if (!a) return false;
      return a.sym.toLowerCase().includes(qq) || a.name.toLowerCase().includes(qq) || a.provider.toLowerCase().includes(qq);
    });
  }, [q, added, assetMap]);

  // dragging
  const onHeaderDown = (e) => {
    const t = e.touches?.[0] ?? e;
    dragRef.current = { x: t.clientX - position.x, y: t.clientY - position.y };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchend', onEnd);
  };
  const onMove = (e) => {
    if (!dragRef.current) return;
    e.preventDefault?.();
    const t = e.touches?.[0] ?? e;
    const x = Math.max(8, Math.min(window.innerWidth - 80, t.clientX - dragRef.current.x));
    const y = Math.max(8, Math.min(window.innerHeight - 80, t.clientY - dragRef.current.y));
    setPosition({ x, y });
  };
  const onEnd = () => {
    dragRef.current = null;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('mouseup', onEnd);
    document.removeEventListener('touchend', onEnd);
  };

  return (
    <>
      <div
        ref={panelRef}
        className={`asset-panel ${collapsed ? 'collapsed' : ''}`}
        style={{ left: position.x, top: position.y }}
      >
        <div className="ap-grip" onMouseDown={onHeaderDown} onTouchStart={onHeaderDown}>
          <span className="ap-dots"><i/><i/></span>
          <span className="ap-title">{collapsed ? `${added.length}` : 'Watchlist'}</span>
          <button
            className="ap-collapse"
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setCollapsed(c => !c); }}
            aria-label={collapsed ? 'Expand' : 'Collapse'}
          >
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path
                d={collapsed ? "M3 2l4 3-4 3" : "M2 3l3 4 3-4"}
                fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        {!collapsed && (
          <>
            <div className="ap-search">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                <circle cx="5" cy="5" r="3"/><path d="M10 10L7.5 7.5"/>
              </svg>
              <input placeholder="Search watchlist" value={q} onChange={(e) => setQ(e.target.value)} />
              {q && <button className="ap-clear" onClick={() => setQ('')}>×</button>}
            </div>

            <div className="ap-list">
              {filtered.map(sym => {
                const a = assetMap[sym];
                if (!a) return null;
                const cs = candlesBySym[sym];
                const last = cs?.[cs.length - 1];
                const prev = cs?.[Math.max(0, cs.length - 24)];
                const chg = last && prev ? (last.c - prev.c) / prev.c : 0;
                const chgColor = chg >= 0 ? 'oklch(0.78 0.16 150)' : 'oklch(0.70 0.20 25)';
                const sparkData = cs ? cs.slice(-32).map(c => c.c) : [];
                return (
                  <div
                    key={sym}
                    className={`ap-row ${activeSym === sym ? 'active' : ''}`}
                    onClick={() => onPick(sym)}
                    style={{ '--row-accent': a.color }}
                  >
                    <div className="ap-row-l">
                      <span className="ap-dot" style={{ background: a.color, boxShadow: `0 0 10px ${a.color}` }} />
                      <div className="ap-row-id">
                        <span className="ap-sym">{a.sym}</span>
                        <span className="ap-prov">{a.provider}</span>
                      </div>
                    </div>
                    <MiniSpark data={sparkData} color={chgColor} />
                    <div className="ap-row-r">
                      <span className="ap-px">{window.TradingData.fmtPrice(last?.c ?? a.seed)}</span>
                      <span className="ap-chg" style={{ color: chgColor }}>{window.TradingData.fmtPct(chg)}</span>
                    </div>
                    <button
                      className="ap-rm"
                      onClick={(e) => { e.stopPropagation(); setAdded(prev => prev.filter(s => s !== sym)); }}
                      aria-label="Remove"
                    >×</button>
                  </div>
                );
              })}
              {filtered.length === 0 && (
                <div className="ap-empty">{q ? 'No match in watchlist' : 'Empty — tap + to add'}</div>
              )}
            </div>

            <button className="ap-add-btn" onClick={() => setAddOpen(true)}>
              <svg width="11" height="11" viewBox="0 0 11 11"><path d="M5.5 1v9M1 5.5h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
              <span>Add asset</span>
            </button>
          </>
        )}

        {collapsed && (
          <div className="ap-collapsed-stack">
            {added.slice(0, 10).map(sym => {
              const a = assetMap[sym];
              if (!a) return null;
              const cs = candlesBySym[sym];
              const last = cs?.[cs.length - 1];
              const prev = cs?.[Math.max(0, cs.length - 24)];
              const chg = last && prev ? (last.c - prev.c) / prev.c : 0;
              const up = chg >= 0;
              const chgColor = up ? 'oklch(0.78 0.16 150)' : 'oklch(0.70 0.20 25)';
              const pctTxt = (up ? '+' : '') + (chg * 100).toFixed(chg >= 0.1 || chg <= -0.1 ? 0 : 1) + '%';
              return (
                <button
                  key={sym}
                  className={`ap-mini ${activeSym === sym ? 'active' : ''}`}
                  onClick={() => onPick(sym)}
                  style={{ '--c': a.color }}
                  title={`${a.sym} · ${window.TradingData.fmtPrice(last?.c ?? a.seed)} · ${pctTxt}`}
                >
                  <span className="apm-dot" style={{ background: a.color, boxShadow: `0 0 8px ${a.color}` }} />
                  <span className="apm-sym">{a.sym}</span>
                  <span className="apm-chg" style={{ color: chgColor }}>
                    <svg width="6" height="6" viewBox="0 0 6 6" style={{ transform: up ? 'none' : 'rotate(180deg)' }}>
                      <path d="M3 1l2.2 3.5h-4.4z" fill="currentColor"/>
                    </svg>
                    {pctTxt}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {addOpen && (
        <AddAssetModal
          providers={providers}
          allAssets={allAssets}
          added={added}
          candlesBySym={candlesBySym}
          onAdd={(sym) => setAdded(prev => prev.includes(sym) ? prev : [...prev, sym])}
          onClose={() => setAddOpen(false)}
        />
      )}
    </>
  );
}

function AddAssetModal({ providers, allAssets, added, candlesBySym, onAdd, onClose }) {
  const [provider, setProvider] = useState(providers[0].id);
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const list = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return allAssets.filter(a => {
      if (qq) {
        return a.sym.toLowerCase().includes(qq) || a.name.toLowerCase().includes(qq) || a.provider.toLowerCase().includes(qq);
      }
      return a.provider === provider;
    });
  }, [provider, q, allAssets]);

  return (
    <div className="scrim" onClick={onClose}>
      <div className="add-modal" onClick={(e) => e.stopPropagation()}>
        <div className="am-header">
          <div className="am-title">Add asset</div>
          <button className="am-close" onClick={onClose}>
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
          </button>
        </div>

        <div className="am-search">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
            <circle cx="6" cy="6" r="3.6"/><path d="M12 12L9 9"/>
          </svg>
          <input
            ref={inputRef}
            placeholder="Search across all providers · BTC · NVDA · NASDAQ"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {q && <button className="am-clear" onClick={() => setQ('')}>clear</button>}
        </div>

        {!q.trim() && (
          <div className="am-providers">
            {providers.map(p => (
              <button
                key={p.id}
                className={`am-prov ${provider === p.id ? 'active' : ''}`}
                onClick={() => setProvider(p.id)}
                style={{ '--p-accent': p.accent }}
              >
                <span className="am-prov-dot" />
                <span className="am-prov-label">{p.label}</span>
                <span className="am-prov-cls">{p.cls}</span>
              </button>
            ))}
          </div>
        )}

        <div className="am-list">
          {list.map(a => {
            const isAdded = added.includes(a.sym);
            const cs = candlesBySym[a.sym];
            const last = cs?.[cs.length - 1];
            const prev = cs?.[Math.max(0, cs.length - 24)];
            const chg = last && prev ? (last.c - prev.c) / prev.c : 0;
            const chgColor = chg >= 0 ? 'oklch(0.78 0.16 150)' : 'oklch(0.70 0.20 25)';
            return (
              <div key={a.sym} className="am-row" style={{ '--row-accent': a.color }}>
                <span className="am-dot" style={{ background: a.color, boxShadow: `0 0 10px ${a.color}` }} />
                <span className="am-sym">{a.sym}</span>
                <span className="am-name">{a.name}</span>
                <span className="am-prov-tag">{a.provider}</span>
                <span className="am-px">{window.TradingData.fmtPrice(last?.c ?? a.seed)}</span>
                <span className="am-chg" style={{ color: chgColor }}>{window.TradingData.fmtPct(chg)}</span>
                <button
                  className={`am-add ${isAdded ? 'added' : ''}`}
                  onClick={() => { if (!isAdded) onAdd(a.sym); }}
                  disabled={isAdded}
                >{isAdded ? '✓' : '+'}</button>
              </div>
            );
          })}
          {list.length === 0 && <div className="ap-empty">No matches</div>}
        </div>
      </div>
    </div>
  );
}

window.AssetPanel = AssetPanel;
