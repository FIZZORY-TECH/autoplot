// ============ App ============
const { useState, useEffect, useMemo, useRef, useCallback } = React;

const TD = window.TradingData;
const { generateOHLC, toHeikinAshi, sma, bollinger, parseUserSeries, fmtPrice, fmtPct } = TD;
const ALL_ASSETS = TD.ASSETS;
const ALL_PROVIDERS = TD.PROVIDERS;
const { ActivityBar, DockDrawer, Watchlist, Dock, Actions, Palette, IndicatorPanel, MarkComposer } = window.Chrome;
const AssetPanel = window.AssetPanel;
const { AgentsPanel } = window.Agents;

// ---- Activity-bar + drawer dock (ADR-0011) ----
// Single source of truth for drawer open-state: one nullable drawer id per side.
// At most one drawer open per side (structural). Width per drawer drives the
// side's chart-inset reserve var.
const DOCK_SIDE = { watchlist: 'left', strategy: 'left', terminal: 'right', portfolio: 'right', indicator: 'right', settings: 'right' };
const DOCK_WIDTH = { watchlist: 352, strategy: 480, terminal: 560, portfolio: 360, indicator: 320, settings: 440 };
const RAIL_W = 48;
const MIN_CHART_W = 240;
// Clamp the open drawer's reserve so the chart column never drops below 240px at
// the 800×600 Tauri minimum.
function reserveFor(id) {
  if (!id) return 0;
  return Math.max(0, Math.min(DOCK_WIDTH[id], window.innerWidth - 2 * RAIL_W - MIN_CHART_W));
}

// Animated number — counts up/down smoothly when value changes
function AnimNum({ value, fmt }) {
  const [display, setDisplay] = useState(value);
  const ref = useRef(value);
  useEffect(() => {
    const start = ref.current;
    const end = value;
    const t0 = performance.now();
    const dur = 600;
    let raf;
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      const v = start + (end - start) * e;
      ref.current = v;
      setDisplay(v);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <span>{fmt(display)}</span>;
}

function App() {
  const assetMap = useMemo(() => Object.fromEntries(ALL_ASSETS.map(a => [a.sym, a])), []);

  // Pre-compute candles for every asset (so we can show prices in tooltips, palette, etc.)
  const rawCandlesBySym = useMemo(() => {
    const out = {};
    for (const a of ALL_ASSETS) out[a.sym] = generateOHLC(a, 600);
    return out;
  }, []);

  const [activeSym, setActiveSym] = useState('BTC');
  const [chartType, setChartType] = useState('candles');
  const [tf, setTf] = useState('4h');
  const [tool, setTool] = useState(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [indicatorFlags, setIndicatorFlags] = useState({ ma20: true, ma50: false, bb: false });
  const [customText, setCustomText] = useState('');
  const [appliedCustom, setAppliedCustom] = useState(null);

  // Dock open-state — single source of truth (one drawer per side). Terminal
  // (the Claude CLI surface) is open by default at launch. Session-only.
  const [openLeft, setOpenLeft] = useState(null);
  const [openRight, setOpenRight] = useState('terminal');
  const toggleDrawer = useCallback((id) => {
    const set = DOCK_SIDE[id] === 'left' ? setOpenLeft : setOpenRight;
    set(cur => (cur === id ? null : id));
  }, []);
  const closeSide = useCallback((side) => {
    (side === 'left' ? setOpenLeft : setOpenRight)(null);
  }, []);

  // Write the reserve CSS vars on every open-state / resize change so the chart
  // insets to make room for the open drawer(s) and re-clamps at narrow widths.
  useEffect(() => {
    const apply = () => {
      const root = document.documentElement;
      root.style.setProperty('--rail-w', RAIL_W + 'px');
      root.style.setProperty('--reserve-left', reserveFor(openLeft) + 'px');
      root.style.setProperty('--reserve-right', reserveFor(openRight) + 'px');
    };
    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, [openLeft, openRight]);

  const [marksBySym, setMarksBySym] = useState({});
  const [composer, setComposer] = useState(null);
  const [crosshair, setCrosshair] = useState(null);

  // User's added assets (the watchlist)
  const [added, setAdded] = useState(['BTC', 'ETH', 'SOL', 'NVDA', 'AAPL', 'TSLA']);

  // Floating panel state
  const initialPanelPos = useMemo(() => ({
    x: 18,
    y: Math.max(96, window.innerHeight / 2 - 240),
  }), []);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [panelPos, setPanelPos] = useState(initialPanelPos);

  const [viewport, setViewport] = useState({ start: 400, end: 600 });
  const resetView = useCallback(() => setViewport({ start: 400, end: 600 }), []);

  // Reset viewport when asset changes (smooth via animated y inside chart)
  const prevSym = useRef(activeSym);
  useEffect(() => {
    if (prevSym.current !== activeSym) {
      // keep same span, just reset to recent window
      setViewport({ start: 400, end: 600 });
      prevSym.current = activeSym;
    }
  }, [activeSym]);

  // Resolve display candles based on type — Heikin Ashi recomputes from raw
  const baseCandles = rawCandlesBySym[activeSym];
  const displayCandles = useMemo(() => {
    if (chartType === 'heikin') return toHeikinAshi(baseCandles);
    return baseCandles;
  }, [baseCandles, chartType]);

  // Chart overlays computed from base (close prices) — the chart-engine overlay
  // vocabulary is unchanged by the panel-UI Overlays→Indicator rename (ADR-0011).
  // Driven by the Indicator panel's indicatorFlags.
  const overlays = useMemo(() => {
    return {
      ma20: indicatorFlags.ma20 ? sma(baseCandles, 20) : null,
      ma50: indicatorFlags.ma50 ? sma(baseCandles, 50) : null,
      bb:   indicatorFlags.bb   ? bollinger(baseCandles, 20, 2) : null,
    };
  }, [baseCandles, indicatorFlags]);

  const customSeries = useMemo(() => {
    if (!appliedCustom) return null;
    return parseUserSeries(appliedCustom, baseCandles.length);
  }, [appliedCustom, baseCandles.length]);

  const marks = marksBySym[activeSym] ?? [];

  // Watchlist groups
  const [groups, setGroups] = useState([]);

  // AI agents state
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [agentMode, setAgentMode] = useState('research');
  const [datasets, setDatasets] = useState([]);
  const [strategies, setStrategies] = useState([]);
  const [activeOverlayId, setActiveOverlayId] = useState(null);
  const [activeStrategyId, setActiveStrategyId] = useState(null);

  const aiOverlay = useMemo(() => {
    if (!activeOverlayId) return null;
    const ds = datasets.find(d => d.id === activeOverlayId);
    if (!ds || ds.sourceSym !== activeSym) return null;
    return { series: ds.series, color: ds.color, label: ds.name };
  }, [activeOverlayId, datasets, activeSym]);

  const aiSignals = useMemo(() => {
    if (!activeStrategyId) return null;
    const st = strategies.find(s => s.id === activeStrategyId);
    if (!st || st.sourceSym !== activeSym) return null;
    return st.signals;
  }, [activeStrategyId, strategies, activeSym]);

  // Keyboard shortcuts (ADR-0011 dock bindings):
  //   ⌘K / · → palette · D → Indicator · ⌘P → Portfolio · ⌘, → Settings
  //   ⌘` → Terminal · R → reset · M/C → mark/comment tools
  //   Esc → close the focused side's drawer (else palette/composer/tool).
  // Watchlist/Strategy are rail-icon-only (no shortcut).
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(true); }
      else if (meta && e.key === '`') { e.preventDefault(); toggleDrawer('terminal'); }
      else if (meta && e.key.toLowerCase() === 'p') { e.preventDefault(); toggleDrawer('portfolio'); }
      else if (meta && e.key === ',') { e.preventDefault(); toggleDrawer('settings'); }
      else if (e.key === '/') { e.preventDefault(); setPaletteOpen(true); }
      else if (e.key.toLowerCase() === 'd' && !meta) { toggleDrawer('indicator'); }
      else if (e.key.toLowerCase() === 'r' && !meta) { resetView(); }
      else if (e.key.toLowerCase() === 'm' && !meta) { setTool(t => t === 'mark' ? null : 'mark'); }
      else if (e.key.toLowerCase() === 'c' && !meta) { setTool(t => t === 'comment' ? null : 'comment'); }
      else if (e.key === 'Escape') {
        // Close the right drawer first, then left, then transient overlays.
        if (openRight) closeSide('right');
        else if (openLeft) closeSide('left');
        else { setPaletteOpen(false); setComposer(null); setTool(null); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [resetView, toggleDrawer, closeSide, openLeft, openRight]);

  // Chart click → if tool active, open composer
  const onChartClick = useCallback((e) => {
    if (tool === 'mark' || tool === 'comment') {
      setComposer({
        x: Math.min(e.clientX, window.innerWidth - 296),
        y: Math.min(e.clientY, window.innerHeight - 200),
        price: e.price,
        kind: tool,
      });
    }
  }, [tool]);

  const saveMark = ({ color, note }) => {
    const newMark = {
      id: 'm' + Math.random().toString(36).slice(2, 8),
      price: composer.price,
      color,
      note: composer.kind === 'comment' ? (note || 'Note') : note,
    };
    setMarksBySym(prev => ({
      ...prev,
      [activeSym]: [...(prev[activeSym] ?? []), newMark],
    }));
    setComposer(null);
    setTool(null);
  };

  // Headline price + delta
  const last = baseCandles[baseCandles.length - 1];
  const open = baseCandles[Math.max(0, baseCandles.length - 24)];
  const delta = last && open ? (last.c - open.c) / open.c : 0;
  const deltaColor = delta >= 0 ? 'oklch(0.78 0.16 150)' : 'oklch(0.70 0.20 25)';
  const a = assetMap[activeSym];

  return (
    <div className="app">
      <Chart
        asset={a}
        candles={displayCandles}
        type={chartType}
        viewport={viewport}
        setViewport={setViewport}
        marks={marks}
        onChartClick={onChartClick}
        overlays={overlays}
        customSeries={customSeries}
        aiOverlay={aiOverlay}
        aiSignals={aiSignals}
        onCrosshairChange={setCrosshair}
        tool={tool}
      />

      <div className="headline" style={{ '--asset-color': a.color }}>
        <div className="sym">
          <span className="dot" />
          <span>{a.sym} · {a.name}</span>
          <span style={{ color: 'var(--ink-3)', marginLeft: 4 }}>{a.cls}</span>
        </div>
        <div className="price">
          <AnimNum value={crosshair?.candle?.c ?? last.c} fmt={fmtPrice} />
        </div>
        <div className="delta" style={{ '--delta-color': deltaColor }}>
          <span className="pill">{fmtPct(delta)}</span>
          <span style={{ color: 'var(--ink-3)' }}>past 24h</span>
          {crosshair?.candle && (
            <span style={{ color: 'var(--ink-3)', fontSize: 11 }}>
              O {fmtPrice(crosshair.candle.o)} · H {fmtPrice(crosshair.candle.h)} · L {fmtPrice(crosshair.candle.l)} · C {fmtPrice(crosshair.candle.c)}
            </span>
          )}
        </div>
      </div>

      {/* Activity rails — always visible, one per side (ADR-0011). */}
      <ActivityBar side="left"  openId={openLeft}  onToggle={toggleDrawer} />
      <ActivityBar side="right" openId={openRight} onToggle={toggleDrawer} />

      {/* Left drawers ----------------------------------------------------- */}
      <DockDrawer side="left" open={openLeft === 'watchlist'} width={DOCK_WIDTH.watchlist} label="Watchlist">
        <AssetPanel
          added={added}
          setAdded={setAdded}
          assetMap={assetMap}
          providers={ALL_PROVIDERS}
          allAssets={ALL_ASSETS}
          activeSym={activeSym}
          onPick={setActiveSym}
          candlesBySym={rawCandlesBySym}
          collapsed={panelCollapsed}
          setCollapsed={setPanelCollapsed}
          position={panelPos}
          setPosition={setPanelPos}
        />
      </DockDrawer>

      <DockDrawer side="left" open={openLeft === 'strategy'} width={DOCK_WIDTH.strategy} label="Strategy">
        <div className="drawer-stub">Strategy editor · CodeMirror</div>
      </DockDrawer>

      {/* Right drawers ---------------------------------------------------- */}
      <DockDrawer side="right" open={openRight === 'terminal'} width={DOCK_WIDTH.terminal} label="Claude CLI">
        <div className="drawer-stub">Claude CLI · Terminal (PTY)</div>
      </DockDrawer>

      <DockDrawer side="right" open={openRight === 'portfolio'} width={DOCK_WIDTH.portfolio} label="Portfolio">
        <div className="drawer-stub">Portfolio · holdings</div>
      </DockDrawer>

      <DockDrawer side="right" open={openRight === 'indicator'} width={DOCK_WIDTH.indicator} label="Indicators">
        <IndicatorPanel
          indicatorFlags={indicatorFlags}
          setIndicatorFlags={setIndicatorFlags}
          customText={customText}
          setCustomText={setCustomText}
          onApplyCustom={() => setAppliedCustom(customText)}
          onClose={() => closeSide('right')}
        />
      </DockDrawer>

      <DockDrawer side="right" open={openRight === 'settings'} width={DOCK_WIDTH.settings} label="Settings">
        <div className="drawer-stub">Settings · Claude CLI config</div>
      </DockDrawer>

      <Dock
        chartType={chartType}
        setChartType={setChartType}
        tf={tf}
        setTf={setTf}
        tool={tool}
        setTool={setTool}
      />

      <Actions
        onPalette={() => setPaletteOpen(true)}
        onResetView={resetView}
      />

      {paletteOpen && (
        <Palette
          assets={ALL_ASSETS}
          candlesBySym={rawCandlesBySym}
          onPick={(s) => { setActiveSym(s); setPaletteOpen(false); }}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {composer && (
        <MarkComposer
          at={composer}
          defaultPrice={composer.price}
          onSave={saveMark}
          onCancel={() => { setComposer(null); setTool(null); }}
        />
      )}

      <AgentsPanel
        open={agentsOpen}
        onClose={setAgentsOpen}
        mode={agentMode}
        setMode={setAgentMode}
        candles={baseCandles}
        activeSym={activeSym}
        datasets={datasets}
        setDatasets={setDatasets}
        strategies={strategies}
        setStrategies={setStrategies}
        activeOverlayId={activeOverlayId}
        setActiveOverlayId={setActiveOverlayId}
        activeStrategyId={activeStrategyId}
        setActiveStrategyId={setActiveStrategyId}
      />

      {(aiOverlay || aiSignals) && (
        <div className="ai-chip-stack">
          {aiOverlay && (
            <div className="ai-active-chip" style={{ '--c': aiOverlay.color }}>
              <span className="aurora tiny" />
              <span className="ai-chip-label">{aiOverlay.label}</span>
              <button onClick={() => setActiveOverlayId(null)}>×</button>
            </div>
          )}
          {aiSignals && (
            <div className="ai-active-chip strat">
              <span className="aurora tiny violet" />
              <span className="ai-chip-label">
                {strategies.find(s => s.id === activeStrategyId)?.name} · {aiSignals.length} signals
              </span>
              <button onClick={() => setActiveStrategyId(null)}>×</button>
            </div>
          )}
        </div>
      )}

      <div className="hint">
        <span><span className="k">⌘ K</span> search</span>
        <span><span className="k">D</span> indicators</span>
        <span><span className="k">M</span> mark</span>
        <span><span className="k">⇧ drag</span> range</span>
        <span><span className="k">scroll</span> zoom</span>
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
