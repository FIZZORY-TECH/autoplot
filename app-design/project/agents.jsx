// ============ AI Co-Research + Co-Strategy Agents ============
const { useState, useEffect, useRef, useMemo, useCallback } = React;

// Pre-baked "research outputs" the AI can plot. In a real product these would be
// computed from market data; here we generate them from the active candles so they
// look correct and animate beautifully.
const RESEARCH_PRESETS = [
  { id: 'rv30',   label: '30d realized volatility',   icon: '⟁', color: 'oklch(0.78 0.16 80)',  desc: 'Rolling stdev of log returns, 30 bars' },
  { id: 'corr',   label: 'Correlation w/ ETH',        icon: '∽', color: 'oklch(0.82 0.14 215)', desc: 'Rolling 60-bar correlation, normalized' },
  { id: 'momo',   label: 'Momentum z-score',          icon: '↗', color: 'oklch(0.78 0.16 150)', desc: 'Z-scored 14-bar return distribution' },
  { id: 'liq',    label: 'Liquidity pressure',        icon: '◌', color: 'oklch(0.78 0.18 320)', desc: 'Volume-weighted order-flow proxy' },
  { id: 'fund',   label: 'Funding rate proxy',        icon: '⌁', color: 'oklch(0.85 0.16 60)',  desc: 'Synthesized perp funding signal' },
];

const STRATEGY_PRESETS = [
  {
    id: 'rsi-mr', label: 'Mean-revert · RSI(14) extremes',
    rules: [
      { kind: 'trigger', label: 'RSI(14) crosses below 30',   icon: 'T' },
      { kind: 'filter',  label: 'Price > 200-bar SMA',        icon: 'F' },
      { kind: 'entry',   label: 'Long · 1.0× notional',       icon: 'E' },
      { kind: 'exit',    label: 'RSI(14) > 55  · stop -3%',   icon: 'X' },
    ],
    perf: { winrate: 0.58, sharpe: 1.42, dd: -0.082, trades: 41 },
    signals: 'rsi-mr',
  },
  {
    id: 'breakout', label: 'Donchian breakout · 20/10',
    rules: [
      { kind: 'trigger', label: 'Close > 20-bar high',        icon: 'T' },
      { kind: 'filter',  label: 'Volume > 1.4× avg(20)',      icon: 'F' },
      { kind: 'entry',   label: 'Long · 0.8× notional',       icon: 'E' },
      { kind: 'exit',    label: 'Close < 10-bar low',         icon: 'X' },
    ],
    perf: { winrate: 0.46, sharpe: 1.18, dd: -0.124, trades: 28 },
    signals: 'breakout',
  },
];

/* ---------- Generators (return arrays aligned to candles) ---------- */
function genResearchSeries(id, candles) {
  const n = candles.length;
  const out = new Array(n).fill(NaN);
  if (id === 'rv30') {
    const ret = candles.map((c, i) => i === 0 ? 0 : Math.log(c.c / candles[i-1].c));
    const w = 30;
    let sum = 0, sumSq = 0;
    for (let i = 0; i < n; i++) {
      sum += ret[i]; sumSq += ret[i] * ret[i];
      if (i >= w) { sum -= ret[i-w]; sumSq -= ret[i-w] * ret[i-w]; }
      if (i >= w - 1) {
        const m = sum / w; const v = sumSq / w - m * m;
        out[i] = Math.sqrt(Math.max(0, v)) * Math.sqrt(365);
      }
    }
    // map [0..1] vol to price scale
    const lo = candles[Math.floor(n*0.7)].l, hi = candles[Math.floor(n*0.7)].h;
    return out.map(v => isFinite(v) ? lo + (hi - lo) * v * 6 : NaN);
  }
  if (id === 'corr') {
    // Synthetic 60-bar smoothed wave hovering near close prices
    const close = candles.map(c => c.c);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc = acc * 0.92 + (Math.sin(i * 0.06) + Math.cos(i * 0.013)) * 0.08;
      out[i] = close[i] * (1 + acc * 0.04);
    }
    return out;
  }
  if (id === 'momo') {
    const close = candles.map(c => c.c);
    for (let i = 14; i < n; i++) {
      const rets = [];
      for (let j = i - 14; j < i; j++) rets.push((close[j+1] - close[j]) / close[j]);
      const m = rets.reduce((a,b)=>a+b,0)/rets.length;
      const sd = Math.sqrt(rets.reduce((a,b)=>a+(b-m)*(b-m),0)/rets.length) || 1e-6;
      const z = ((close[i]-close[i-14])/close[i-14] - m) / sd;
      out[i] = close[i] * (1 + z * 0.012);
    }
    return out;
  }
  if (id === 'liq' || id === 'fund') {
    const close = candles.map(c => c.c);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const v = candles[i].v;
      acc = acc * 0.85 + (v - 1) * 0.15;
      const phase = id === 'liq' ? Math.sin(i*0.04) : Math.cos(i*0.025);
      out[i] = close[i] * (1 + acc * 0.02 + phase * 0.015);
    }
    return out;
  }
  return out;
}

function genStrategySignals(id, candles) {
  const n = candles.length;
  const close = candles.map(c => c.c);
  const out = [];
  if (id === 'rsi-mr') {
    // simulate rsi-like oscillator
    const w = 14;
    let last = 'flat';
    for (let i = w; i < n; i++) {
      let g = 0, l = 0;
      for (let j = i - w + 1; j <= i; j++) {
        const d = close[j] - close[j-1];
        if (d > 0) g += d; else l -= d;
      }
      const rsi = 100 - 100 / (1 + (g / Math.max(l, 1e-9)));
      if (rsi < 30 && last !== 'long') {
        out.push({ t: i, side: 'buy', price: close[i] });
        last = 'long';
      } else if ((rsi > 55) && last === 'long') {
        out.push({ t: i, side: 'sell', price: close[i] });
        last = 'flat';
      }
    }
  } else if (id === 'breakout') {
    let last = 'flat';
    for (let i = 20; i < n; i++) {
      const hi = Math.max(...close.slice(i-20, i));
      const lo = Math.min(...close.slice(i-10, i));
      if (close[i] > hi && last !== 'long') {
        out.push({ t: i, side: 'buy', price: close[i] });
        last = 'long';
      } else if (close[i] < lo && last === 'long') {
        out.push({ t: i, side: 'sell', price: close[i] });
        last = 'flat';
      }
    }
  }
  return out;
}

/* ---------- Thinking trace animation ---------- */
function ThinkingTrace({ steps, onDone }) {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    if (stage >= steps.length) { onDone?.(); return; }
    const dur = steps[stage].dur ?? 700;
    const t = setTimeout(() => setStage(s => s + 1), dur);
    return () => clearTimeout(t);
  }, [stage, steps, onDone]);
  return (
    <div className="ai-trace">
      {steps.map((s, i) => {
        const state = i < stage ? 'done' : (i === stage ? 'live' : 'pending');
        return (
          <div key={i} className={`trace-row ${state}`}>
            <span className="trace-bullet">
              {state === 'done' ? (
                <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5l2 2 4-4" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
              ) : state === 'live' ? (
                <span className="trace-spin" />
              ) : <span className="trace-dot" />}
            </span>
            <span className="trace-label">{s.label}</span>
            {s.detail && <span className="trace-detail">{s.detail}</span>}
            {state === 'live' && <span className="trace-shimmer" />}
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Strategy workflow visualization ---------- */
function StrategyFlow({ rules, animate }) {
  return (
    <div className="strat-flow">
      {rules.map((r, i) => (
        <React.Fragment key={i}>
          <div className={`strat-node ${r.kind}`} style={{ animationDelay: animate ? `${i * 120}ms` : '0ms' }}>
            <span className="sn-badge">{r.icon}</span>
            <div className="sn-body">
              <span className="sn-kind">{r.kind}</span>
              <span className="sn-label">{r.label}</span>
            </div>
          </div>
          {i < rules.length - 1 && (
            <div className="strat-edge" style={{ animationDelay: animate ? `${i * 120 + 60}ms` : '0ms' }}>
              <svg viewBox="0 0 14 14" width="14" height="14"><path d="M2 7h10M9 4l3 3-3 3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

/* ---------- AI panel ---------- */
function AgentsPanel({
  open, onClose, mode, setMode,
  candles, activeSym,
  datasets, setDatasets,
  strategies, setStrategies,
  activeOverlayId, setActiveOverlayId,
  activeStrategyId, setActiveStrategyId,
}) {
  const [view, setView] = useState('chat'); // chat | library
  const [thread, setThread] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingDataset, setPendingDataset] = useState(null);
  const [pendingStrategy, setPendingStrategy] = useState(null);
  const [attached, setAttached] = useState([]); // user reference data
  const threadRef = useRef(null);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [thread, busy]);

  const seedThread = useMemo(() => mode === 'research'
    ? [{ role: 'agent', kind: 'intro', text: `Research agent online. Ask me to analyze ${activeSym}, pull a metric, compare assets, or plot anything.` }]
    : [{ role: 'agent', kind: 'intro', text: `Strategy agent ready. Describe a thesis or rule — I'll prototype it on ${activeSym} and surface signals on the chart.` }],
  [mode, activeSym]);

  useEffect(() => { setThread(seedThread); setBusy(false); setPendingDataset(null); setPendingStrategy(null); }, [mode, seedThread]);

  const send = (textOverride) => {
    const text = (textOverride ?? input).trim();
    if (!text || busy) return;
    setInput('');
    setThread(t => [...t, { role: 'user', text, attachments: attached.slice() }]);
    setAttached([]);
    setBusy(true);

    if (mode === 'research') {
      // Pick a preset based on keywords; default to first
      const lower = text.toLowerCase();
      let chosen = RESEARCH_PRESETS[0];
      for (const p of RESEARCH_PRESETS) {
        if (p.id === 'rv30' && /(volatility|vol|risk)/.test(lower)) { chosen = p; break; }
        if (p.id === 'corr' && /(corr|relationship|paired|eth|btc)/.test(lower)) { chosen = p; break; }
        if (p.id === 'momo' && /(momentum|trend|breakout)/.test(lower)) { chosen = p; break; }
        if (p.id === 'liq' && /(liquidity|order|flow|depth)/.test(lower)) { chosen = p; break; }
        if (p.id === 'fund' && /(fund|perp|carry|basis)/.test(lower)) { chosen = p; break; }
      }
      const traceSteps = [
        { label: 'Parsing intent',         detail: 'identify metric · time horizon', dur: 700 },
        { label: `Pulling ${activeSym} OHLCV`, detail: '600 bars · 4h',                 dur: 900 },
        { label: `Computing ${chosen.label.toLowerCase()}`, detail: chosen.desc,        dur: 1100 },
        { label: 'Aligning to chart axis', detail: 'normalizing scale · last 200 bars', dur: 700 },
        { label: 'Plotting overlay',       detail: 'streaming to canvas',                dur: 700 },
      ];
      setPendingDataset({ preset: chosen, steps: traceSteps, prompt: text });
    } else {
      const lower = text.toLowerCase();
      let chosen = STRATEGY_PRESETS[0];
      if (/(break|donchian|breakout)/.test(lower)) chosen = STRATEGY_PRESETS[1];
      const traceSteps = [
        { label: 'Decomposing thesis',         detail: 'isolate trigger · filter · entry · exit', dur: 700 },
        { label: 'Selecting indicators',       detail: chosen.rules[0].label,                       dur: 800 },
        { label: 'Building rule graph',        detail: `${chosen.rules.length} nodes`,              dur: 900 },
        { label: 'Backtesting on 600 bars',    detail: 'simulating fills · 1 bp slippage',          dur: 1100 },
        { label: 'Rendering signals on chart', detail: `${activeSym} · 4h candles`,                 dur: 700 },
      ];
      setPendingStrategy({ preset: chosen, steps: traceSteps, prompt: text });
    }
  };

  const finishResearch = () => {
    const { preset, prompt } = pendingDataset;
    const series = genResearchSeries(preset.id, candles);
    const ds = {
      id: 'ds_' + Math.random().toString(36).slice(2, 8),
      name: preset.label, color: preset.color, sourceSym: activeSym,
      series, prompt, createdAt: Date.now(),
    };
    setDatasets(prev => [ds, ...prev]);
    setActiveOverlayId(ds.id);
    setThread(t => [...t, {
      role: 'agent', kind: 'research-result', text: `Plotted ${preset.label} for ${activeSym}.`,
      datasetId: ds.id, color: preset.color, label: preset.label,
    }]);
    setPendingDataset(null);
    setBusy(false);
  };
  const finishStrategy = () => {
    const { preset, prompt } = pendingStrategy;
    const signals = genStrategySignals(preset.signals, candles);
    const st = {
      id: 'st_' + Math.random().toString(36).slice(2, 8),
      name: preset.label, rules: preset.rules.slice(), perf: preset.perf,
      signals, sourceSym: activeSym, prompt, createdAt: Date.now(),
    };
    setStrategies(prev => [st, ...prev]);
    setActiveStrategyId(st.id);
    setThread(t => [...t, {
      role: 'agent', kind: 'strategy-result', text: `Drafted strategy. ${signals.length} signals on ${activeSym}.`,
      strategyId: st.id,
    }]);
    setPendingStrategy(null);
    setBusy(false);
  };

  return (
    <>
      <button className={`agents-fab ${open ? 'open' : ''}`} onClick={() => onClose(!open)} title="AI agents">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <circle cx="10" cy="10" r="6" stroke="currentColor" strokeWidth="1.4"/>
          <circle cx="7.5" cy="9" r="1" fill="currentColor"/>
          <circle cx="12.5" cy="9" r="1" fill="currentColor"/>
          <path d="M7 12.5c1 1 2 1.2 3 1.2s2-.2 3-1.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none"/>
        </svg>
        <span className="fab-pulse" />
      </button>

      {open && (
        <div className="agents-panel">
          <div className="ag-head">
            <div className="ag-mode">
              <button className={`ag-mode-btn ${mode === 'research' ? 'active' : ''}`} onClick={() => setMode('research')}>
                <span className="dot" style={{ background: 'oklch(0.82 0.14 215)' }} /> Research
              </button>
              <button className={`ag-mode-btn ${mode === 'strategy' ? 'active' : ''}`} onClick={() => setMode('strategy')}>
                <span className="dot" style={{ background: 'oklch(0.78 0.18 320)' }} /> Strategy
              </button>
            </div>
            <div className="ag-tools">
              <button className={`ag-tab ${view === 'chat' ? 'active' : ''}`} onClick={() => setView('chat')}>Chat</button>
              <button className={`ag-tab ${view === 'library' ? 'active' : ''}`} onClick={() => setView('library')}>Library</button>
              <button className="ag-x" onClick={() => onClose(false)}>
                <svg width="11" height="11" viewBox="0 0 11 11"><path d="M2 2l7 7M9 2l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
              </button>
            </div>
          </div>

          {view === 'chat' && (
            <>
              <div className="ag-thread" ref={threadRef}>
                {thread.map((m, i) => (
                  <Message key={i} m={m} datasets={datasets} strategies={strategies} setActiveOverlayId={setActiveOverlayId} setActiveStrategyId={setActiveStrategyId} activeOverlayId={activeOverlayId} activeStrategyId={activeStrategyId} />
                ))}
                {busy && pendingDataset && (
                  <div className="msg agent">
                    <div className="msg-avatar"><span className="aurora" /></div>
                    <div className="msg-body">
                      <ThinkingTrace steps={pendingDataset.steps} onDone={finishResearch} />
                    </div>
                  </div>
                )}
                {busy && pendingStrategy && (
                  <div className="msg agent">
                    <div className="msg-avatar"><span className="aurora violet" /></div>
                    <div className="msg-body">
                      <ThinkingTrace steps={pendingStrategy.steps} onDone={finishStrategy} />
                      <div style={{ marginTop: 10, opacity: 0.8 }}>
                        <StrategyFlow rules={pendingStrategy.preset.rules} animate />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="ag-prompts">
                {(mode === 'research' ? [
                  'Plot 30d realized volatility',
                  'Correlation with ETH',
                  'Momentum z-score',
                ] : [
                  'RSI oversold mean revert',
                  'Donchian 20/10 breakout',
                  'Edit: tighten stop to 2%',
                ]).map((p, i) => (
                  <button key={i} className="ag-prompt" onClick={() => send(p)} disabled={busy}>{p}</button>
                ))}
              </div>

              <div className="ag-composer">
                {attached.length > 0 && (
                  <div className="ag-attached">
                    {attached.map((a, i) => (
                      <span key={i} className="attached-chip">
                        <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M2 1h4l2 2v5H2z"/></svg>
                        {a.name}
                        <button onClick={() => setAttached(arr => arr.filter((_,j)=>j!==i))}>×</button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="ag-composer-row">
                  <button
                    className="ag-attach"
                    onClick={() => {
                      const name = prompt('Reference dataset name? (e.g. portfolio.csv)');
                      if (name) setAttached(arr => [...arr, { name, size: '—' }]);
                    }}
                    title="Attach reference data"
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 4L5 8a2 2 0 002.8 2.8L12 6.6a3.5 3.5 0 00-4.95-4.95L3 5.7a5 5 0 007 7L13 10"/>
                    </svg>
                  </button>
                  <input
                    placeholder={mode === 'research' ? 'Ask the research agent…' : 'Describe a strategy or edit…'}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
                    disabled={busy}
                  />
                  <button className="ag-send" onClick={() => send()} disabled={busy || !input.trim()}>
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2 7l10-5-3 12-2-5z"/>
                    </svg>
                  </button>
                </div>
              </div>
            </>
          )}

          {view === 'library' && (
            <Library
              mode={mode}
              datasets={datasets} setDatasets={setDatasets}
              strategies={strategies} setStrategies={setStrategies}
              activeOverlayId={activeOverlayId} setActiveOverlayId={setActiveOverlayId}
              activeStrategyId={activeStrategyId} setActiveStrategyId={setActiveStrategyId}
            />
          )}
        </div>
      )}
    </>
  );
}

function Message({ m, datasets, strategies, activeOverlayId, activeStrategyId, setActiveOverlayId, setActiveStrategyId }) {
  if (m.role === 'user') {
    return (
      <div className="msg user">
        <div className="msg-body">
          <div className="msg-text">{m.text}</div>
          {m.attachments?.length > 0 && (
            <div className="msg-attached">
              {m.attachments.map((a, i) => <span key={i} className="attached-chip small">{a.name}</span>)}
            </div>
          )}
        </div>
      </div>
    );
  }
  if (m.kind === 'research-result') {
    const ds = datasets.find(d => d.id === m.datasetId);
    return (
      <div className="msg agent">
        <div className="msg-avatar"><span className="aurora" /></div>
        <div className="msg-body">
          <div className="msg-text">{m.text}</div>
          <div className="ds-card" style={{ '--ds-color': m.color }}>
            <span className="ds-swatch" />
            <span className="ds-label">{m.label}</span>
            <span className="ds-meta">{ds?.sourceSym}</span>
            <button
              className={`ds-toggle ${activeOverlayId === m.datasetId ? 'on' : ''}`}
              onClick={() => setActiveOverlayId(activeOverlayId === m.datasetId ? null : m.datasetId)}
            >{activeOverlayId === m.datasetId ? 'on chart' : 'plot'}</button>
          </div>
        </div>
      </div>
    );
  }
  if (m.kind === 'strategy-result') {
    const st = strategies.find(s => s.id === m.strategyId);
    if (!st) return null;
    return (
      <div className="msg agent">
        <div className="msg-avatar"><span className="aurora violet" /></div>
        <div className="msg-body">
          <div className="msg-text">{m.text}</div>
          <div className="strat-card">
            <div className="strat-card-head">
              <span className="strat-name">{st.name}</span>
              <button
                className={`ds-toggle ${activeStrategyId === st.id ? 'on' : ''}`}
                onClick={() => setActiveStrategyId(activeStrategyId === st.id ? null : st.id)}
              >{activeStrategyId === st.id ? 'on chart' : 'apply'}</button>
            </div>
            <StrategyFlow rules={st.rules} animate />
            <div className="strat-perf">
              <span><i>WR</i>{(st.perf.winrate*100).toFixed(0)}%</span>
              <span><i>SR</i>{st.perf.sharpe.toFixed(2)}</span>
              <span><i>DD</i>{(st.perf.dd*100).toFixed(1)}%</span>
              <span><i>N</i>{st.perf.trades}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="msg agent">
      <div className="msg-avatar"><span className="aurora" /></div>
      <div className="msg-body"><div className="msg-text">{m.text}</div></div>
    </div>
  );
}

function Library({ mode, datasets, setDatasets, strategies, setStrategies, activeOverlayId, setActiveOverlayId, activeStrategyId, setActiveStrategyId }) {
  if (mode === 'research') {
    return (
      <div className="ag-library">
        <div className="lib-section-title">Saved datasets · reusable</div>
        {datasets.length === 0 && <div className="lib-empty">No datasets yet — ask the research agent to plot something.</div>}
        {datasets.map(d => (
          <div key={d.id} className="lib-card" style={{ '--ds-color': d.color }}>
            <span className="ds-swatch" />
            <div className="lib-body">
              <span className="lib-name">{d.name}</span>
              <span className="lib-sub">{d.sourceSym} · "{d.prompt.slice(0, 40)}{d.prompt.length > 40 ? '…' : ''}"</span>
            </div>
            <button
              className={`ds-toggle ${activeOverlayId === d.id ? 'on' : ''}`}
              onClick={() => setActiveOverlayId(activeOverlayId === d.id ? null : d.id)}
            >{activeOverlayId === d.id ? 'on' : 'plot'}</button>
            <button className="lib-rm" onClick={() => setDatasets(arr => arr.filter(x => x.id !== d.id))}>×</button>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="ag-library">
      <div className="lib-section-title">Saved strategies · reusable</div>
      {strategies.length === 0 && <div className="lib-empty">No strategies yet — describe a thesis to the strategy agent.</div>}
      {strategies.map(s => (
        <div key={s.id} className="lib-card strat">
          <div className="lib-body" style={{ flex: 1 }}>
            <span className="lib-name">{s.name}</span>
            <StrategyFlow rules={s.rules} animate={false} />
            <div className="strat-perf compact">
              <span><i>WR</i>{(s.perf.winrate*100).toFixed(0)}%</span>
              <span><i>SR</i>{s.perf.sharpe.toFixed(2)}</span>
              <span><i>DD</i>{(s.perf.dd*100).toFixed(1)}%</span>
            </div>
          </div>
          <div className="lib-actions">
            <button
              className={`ds-toggle ${activeStrategyId === s.id ? 'on' : ''}`}
              onClick={() => setActiveStrategyId(activeStrategyId === s.id ? null : s.id)}
            >{activeStrategyId === s.id ? 'on' : 'apply'}</button>
            <button className="lib-rm" onClick={() => setStrategies(arr => arr.filter(x => x.id !== s.id))}>×</button>
          </div>
        </div>
      ))}
    </div>
  );
}

window.Agents = { AgentsPanel };
