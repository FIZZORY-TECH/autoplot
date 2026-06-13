/**
 * src/pages/DesignPreview.tsx — Dev-only design system preview (P0-16)
 *
 * Mirrors app-design/project/Design System.html §01–§06 for visual diffing.
 * Gated by import.meta.env.DEV — production builds should not reach this.
 *
 * Sections:
 *   §01 Color   — surface swatches, glass tints, hairlines, signal accents, ink ramp
 *   §02 Type    — full typography ramp with sample text
 *   §03 Form    — radius scale, spacing scale, elevation, motion (ease balls)
 *   §04 Components — headline/delta, buttons, pills, tf-scrubber, toggles,
 *                    mark + composer
 *   §05 Agentic — aurora avatar, trace, strategy flow
 *   §06 Principles — the 6 design principles
 */

import styles from "./DesignPreview.module.css";

// ---------------------------------------------------------------------------
// Primitives re-used across sections
// ---------------------------------------------------------------------------

function SectionHead({
  num,
  title,
  sub,
}: {
  num: string;
  title: string;
  sub: string;
}) {
  return (
    <header className={styles.sectionHead}>
      <span className={styles.sectionNum}>{num}</span>
      <h2 className={styles.sectionTitle}>{title}</h2>
      <span className={styles.sectionSub}>{sub}</span>
    </header>
  );
}

// ---------------------------------------------------------------------------
// §01 Color
// ---------------------------------------------------------------------------

function Swatch({
  className,
  name,
  val,
  style,
}: {
  className?: string;
  name: string;
  val: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className={`${styles.swatch} ${className ?? ""}`} style={style}>
      <div className={styles.swName}>{name}</div>
      <div className={styles.swVal}>{val}</div>
    </div>
  );
}

function SignalSwatch({
  className,
  name,
  val,
  style,
  pureStyle,
}: {
  className?: string;
  name: string;
  val: string;
  style?: React.CSSProperties;
  pureStyle?: React.CSSProperties;
}) {
  return (
    <div className={`${styles.swatch} ${className ?? ""}`} style={style}>
      <div className={styles.swPure} style={pureStyle} />
      <div className={styles.swName}>{name}</div>
      <div className={styles.swVal}>{val}</div>
    </div>
  );
}

function GlassSwatch({
  name,
  val,
  tint,
}: {
  name: string;
  val: string;
  tint: string;
}) {
  return (
    <div className={styles.swGlass} style={{ "--c": tint } as React.CSSProperties}>
      <div className={styles.swGlassInner} />
      <div className={styles.swName}>{name}</div>
      <div className={styles.swVal}>{val}</div>
    </div>
  );
}

function InkSwatch({
  name,
  val,
  inkVar,
}: {
  name: string;
  val: string;
  inkVar: string;
}) {
  return (
    <div
      className={styles.swInk}
      style={{ "--c": `var(${inkVar})` } as React.CSSProperties}
    >
      <div className={styles.swName} style={{ color: `var(${inkVar})` }}>
        {name}
      </div>
      <div className={styles.swVal}>{val}</div>
    </div>
  );
}

function ColorSection() {
  return (
    <section className={styles.section}>
      <SectionHead
        num="01"
        title="Color"
        sub="oklch · color-mix(oklab) · all hues at chroma ≤ 0.20"
      />

      <div className={styles.grid2} style={{ gridTemplateColumns: "1.1fr 0.9fr" }}>
        {/* Surfaces + glass */}
        <div className={styles.panel}>
          <h4 className={styles.panelH4}>Surfaces · cool blue-grey base (hue 260)</h4>
          <div className={styles.swatchRow}>
            <Swatch className={styles.swBg0} name="bg-0 · void" val="oklch(0.11 0.008 260)" />
            <Swatch className={styles.swBg1} name="bg-1 · panel" val="oklch(0.14 0.010 260)" />
            <Swatch className={styles.swBg2} name="bg-2 · raised" val="oklch(0.18 0.012 260)" />
          </div>
          <h4 className={styles.panelH4} style={{ marginTop: 22 }}>
            Glass tints — frosted material
          </h4>
          <div className={styles.swatchRow}>
            <GlassSwatch name="glass" val="white 4% / blur 28" tint="color-mix(in oklab, white 4%, transparent)" />
            <GlassSwatch name="glass-strong" val="white 8%" tint="color-mix(in oklab, white 8%, transparent)" />
            <GlassSwatch name="glass-heavy" val="white 12%" tint="color-mix(in oklab, white 12%, transparent)" />
          </div>
          <h4 className={styles.panelH4} style={{ marginTop: 22 }}>
            Hairlines
          </h4>
          <div className={styles.swatchRow}>
            <Swatch
              className={styles.swBg1}
              name="hairline"
              val="white 8%"
              style={{ borderColor: "color-mix(in oklab, white 8%, transparent)" }}
            />
            <Swatch
              className={styles.swBg1}
              name="hairline-2"
              val="white 14%"
              style={{ borderColor: "color-mix(in oklab, white 14%, transparent)" }}
            />
          </div>
        </div>

        {/* Ink ramp */}
        <div className={styles.panel}>
          <h4 className={styles.panelH4}>Ink ramp · text on dark</h4>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <InkSwatch name="ink-0 · primary" val="oklch(0.96 0.005 260)" inkVar="--ink-0" />
            <InkSwatch name="ink-1 · body"    val="oklch(0.78 0.008 260)" inkVar="--ink-1" />
            <InkSwatch name="ink-2 · muted"   val="oklch(0.55 0.010 260)" inkVar="--ink-2" />
            <InkSwatch name="ink-3 · meta"    val="oklch(0.36 0.010 260)" inkVar="--ink-3" />
            <InkSwatch name="ink-4 · disabled" val="oklch(0.24 0.010 260)" inkVar="--ink-4" />
          </div>
        </div>
      </div>

      {/* Signal swatches */}
      <div className={styles.panel} style={{ marginTop: 18 }}>
        <h4 className={styles.panelH4}>Signal · semantic accents (chroma 0.14–0.20, varied hue)</h4>
        <div className={styles.swatchRow}>
          <SignalSwatch className={styles.swUp}     name="up · bull"          val="oklch(0.78 0.16 150)" style={{"--c": "var(--up)"} as React.CSSProperties}     pureStyle={{ background: "var(--up)",     boxShadow: "0 0 14px var(--up)" }} />
          <SignalSwatch className={styles.swDown}   name="down · bear"        val="oklch(0.70 0.20 25)"  style={{"--c": "var(--down)"} as React.CSSProperties}   pureStyle={{ background: "var(--down)",   boxShadow: "0 0 14px var(--down)" }} />
          <SignalSwatch className={styles.swAcc}    name="accent · interactive" val="oklch(0.82 0.14 215)" style={{"--c": "var(--accent)"} as React.CSSProperties} pureStyle={{ background: "var(--accent)", boxShadow: "0 0 14px var(--accent)" }} />
          <SignalSwatch className={styles.swWarn}   name="warn · alert"       val="oklch(0.85 0.16 80)"  style={{"--c": "var(--warn)"} as React.CSSProperties}   pureStyle={{ background: "var(--warn)",   boxShadow: "0 0 14px var(--warn)" }} />
          <SignalSwatch className={styles.swViolet} name="violet · agentic"   val="oklch(0.78 0.18 320)" style={{"--c": "var(--violet)"} as React.CSSProperties} pureStyle={{ background: "var(--violet)", boxShadow: "0 0 14px var(--violet)" }} />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// §02 Type
// ---------------------------------------------------------------------------

function TypeSection() {
  return (
    <section className={styles.section}>
      <SectionHead
        num="02"
        title="Type"
        sub="Geist (UI) · Geist Mono (numeric · meta · ticker)"
      />
      <div className={`glass-card ${styles.typeStack}`}>
        <div className={styles.typeRow}>
          <div className={styles.typeMeta}>
            Display / Price<span className={styles.typeMetaV}>font-mono · 76px</span>
            <span className={styles.typeMetaV}>tracking −0.025em · weight 400</span>
          </div>
          <div className="t-display">$172.40</div>
        </div>
        <div className={styles.typeRow}>
          <div className={styles.typeMeta}>
            H1 / Section<span className={styles.typeMetaV}>sans · 28px</span>
            <span className={styles.typeMetaV}>tracking −0.02em · weight 400</span>
          </div>
          <div className="t-h1">Order book momentum</div>
        </div>
        <div className={styles.typeRow}>
          <div className={styles.typeMeta}>
            H2 / Card<span className={styles.typeMetaV}>sans · 16px · 500</span>
          </div>
          <div className="t-h2">Watchlist · Equities</div>
        </div>
        <div className={styles.typeRow}>
          <div className={styles.typeMeta}>
            Body<span className={styles.typeMetaV}>sans · 13px · 1.55</span>
            <span className={styles.typeMetaV}>color: ink-1</span>
          </div>
          <p className="t-body">
            Co-research surfaces what's moving the tape and proposes hypotheses;
            co-strategy turns them into rules with backtested edge.
          </p>
        </div>
        <div className={styles.typeRow}>
          <div className={styles.typeMeta}>
            Mono · readout<span className={styles.typeMetaV}>mono · 13px</span>
            <span className={styles.typeMetaV}>tabular-nums · ss01 cv11</span>
          </div>
          <div className="t-mono-md">SPY · 04:12:55 EST · vol 38.2M</div>
        </div>
        <div className={styles.typeRow}>
          <div className={styles.typeMeta}>
            Mono · meta<span className={styles.typeMetaV}>mono · 11px</span>
            <span className={styles.typeMetaV}>tracking 0.06em</span>
          </div>
          <div className="t-mono-sm">BID 172.39 · ASK 172.41 · SPREAD 0.02</div>
        </div>
        <div className={styles.typeRow} style={{ borderBottom: 0, paddingBottom: 0 }}>
          <div className={styles.typeMeta}>
            Eyebrow<span className={styles.typeMetaV}>mono · 10px</span>
            <span className={styles.typeMetaV}>tracking 0.20em · uppercase</span>
          </div>
          <div className="t-eyebrow">Live · primary feed</div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// §03 Form
// ---------------------------------------------------------------------------

const RADII = [4, 8, 12, 14, 18, 22] as const;
const SPACINGS = [4, 6, 8, 12, 16, 22, 32, 56] as const;

function FormSection() {
  return (
    <section className={styles.section}>
      <SectionHead
        num="03"
        title="Form"
        sub="spacing · radii · elevation · motion"
      />
      <div className={styles.grid2}>
        <div className={styles.panel}>
          <h4 className={styles.panelH4}>Radius scale</h4>
          <div className={styles.radiusRow}>
            {RADII.map((r) => (
              <div
                key={r}
                className={styles.radiusChip}
                style={{ borderRadius: r }}
              >
                {r}
              </div>
            ))}
            <div className={styles.radiusChip} style={{ borderRadius: 999 }}>
              pill
            </div>
          </div>
          <h4 className={styles.panelH4} style={{ marginTop: 26 }}>Spacing</h4>
          <div className={styles.spacingRow}>
            {SPACINGS.map((sp) => (
              <div key={sp} className={styles.spCell}>
                <div className={styles.spBar} style={{ width: sp }} />
                {sp}
              </div>
            ))}
          </div>
        </div>

        <div className={styles.panel}>
          <h4 className={styles.panelH4}>Elevation · glass shadow</h4>
          <div className={styles.shadowTile}>shadow-glass</div>
          <p className="t-mono-sm" style={{ margin: "14px 0 0" }}>
            inset white 10% top + ring + 30/60 black drop. Always paired with
            backdrop-filter: blur(20–40px) saturate(140–180%).
          </p>
          <h4 className={styles.panelH4} style={{ marginTop: 26 }}>Motion</h4>
          <div className={styles.easeRow}>
            <div className={styles.easeTrack}>
              <span>ease</span>
              <div className={styles.easeBar}>
                <div className={`${styles.easeBall} ${styles.a1}`} />
              </div>
              <span>320ms</span>
            </div>
            <div className={styles.easeTrack}>
              <span>ease-spring</span>
              <div className={styles.easeBar}>
                <div className={`${styles.easeBall} ${styles.a2}`} />
              </div>
              <span>320ms</span>
            </div>
            <div className={styles.easeTrack}>
              <span>linear</span>
              <div className={styles.easeBar}>
                <div className={`${styles.easeBall} ${styles.a3}`} />
              </div>
              <span>—</span>
            </div>
          </div>
          <p className="t-mono-sm" style={{ margin: "12px 0 0" }}>
            durations: t-fast 180 · t-med 320 · t-slow 560
          </p>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// §04 Components
// ---------------------------------------------------------------------------

function ComponentsSection() {
  return (
    <section className={styles.section}>
      <SectionHead
        num="04"
        title="Components"
        sub="glass · pill · readout · trace"
      />

      {/* Headline + delta */}
      <div className="glass-card" style={{ marginBottom: 18 }}>
        <div className={styles.demoHeadline}>
          <div className={styles.sym}>
            <span className={styles.dot} /> SPY · S&amp;P 500 ETF
          </div>
          <div className={styles.price}>$172.40</div>
          <div className={styles.delta}>
            <span className={`${styles.deltaPill} ${styles.up}`}>+1.24%</span>
            <span>+$2.11 · today</span>
          </div>
        </div>
      </div>

      {/* Buttons */}
      <div className={styles.panel} style={{ padding: 0 }}>
        <h4 className={styles.panelH4} style={{ padding: "24px 24px 0" }}>Buttons &amp; controls</h4>
        <div className={styles.btnRow}>
          <button className={styles.actionBtn} aria-label="search">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
            </svg>
          </button>
          <button className={styles.actionBtn} aria-label="settings">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <circle cx="12" cy="12" r="3" />
              <path d="M19 12c0 .5-.1 1-.2 1.4l2 1.5-2 3.5-2.4-.7c-.7.6-1.6 1-2.5 1.3l-.4 2.5h-4l-.4-2.5c-.9-.3-1.7-.7-2.5-1.3l-2.4.7-2-3.5 2-1.5C2.1 13 2 12.5 2 12s.1-1 .2-1.4l-2-1.5 2-3.5 2.4.7c.7-.6 1.6-1 2.5-1.3L7.5 2.5h4l.4 2.5c.9.3 1.7.7 2.5 1.3l2.4-.7 2 3.5-2 1.5c.1.4.2.9.2 1.4z" />
            </svg>
          </button>
          <div className={styles.dockBtn}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 17l6-6 4 4 8-8" />
            </svg>
          </div>
          <div className={`${styles.dockBtn} ${styles.dockBtnActive}`}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="3" y="3" width="18" height="18" rx="3" />
              <path d="M8 8v8M12 6v12M16 10v6" />
            </svg>
          </div>
          <button className={styles.primaryBtn}>Save mark</button>
          <button className={styles.ghostBtn}>Apply</button>
          <span className={`${styles.toggle} ${styles.toggleOn}`} role="switch" />
          <span className={styles.toggle} role="switch" />
        </div>
      </div>

      {/* Pills + scrubber */}
      <div className={styles.grid2} style={{ marginTop: 18 }}>
        <div className={styles.panel}>
          <h4 className={styles.panelH4}>Pills &amp; chips</h4>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <span className={styles.chip}><span className={styles.chipDot} style={{ background: "var(--up)", boxShadow: "0 0 8px var(--up)" }} /> Live · NYSE</span>
            <span className={styles.chip}><span className={styles.chipDot} style={{ background: "var(--warn)", boxShadow: "0 0 8px var(--warn)" }} /> 12 alerts</span>
            <span className={styles.chip}><span className={styles.chipDot} /> Co-research</span>
            <span className={`${styles.deltaPill} ${styles.up}`}>+0.84%</span>
            <span className={`${styles.deltaPill} ${styles.down}`}>−2.31%</span>
          </div>
          <h4 className={styles.panelH4} style={{ marginTop: 22 }}>Provider tag</h4>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <span className={styles.chip} style={{ background: "color-mix(in oklab, var(--accent) 18%, transparent)", borderColor: "color-mix(in oklab, var(--accent) 50%, transparent)", color: "var(--ink-0)" }}>
              <span className={styles.chipDot} /> Polygon · EQ
            </span>
            <span className={styles.chip}><span className={styles.chipDot} style={{ background: "var(--up)", boxShadow: "0 0 8px var(--up)" }} /> CoinGecko · CRYPTO</span>
            <span className={styles.chip}><span className={styles.chipDot} style={{ background: "var(--warn)", boxShadow: "0 0 8px var(--warn)" }} /> CME · FUT</span>
          </div>
        </div>
        <div className={styles.panel}>
          <h4 className={styles.panelH4}>Timeframe scrubber</h4>
          <div className={styles.tfScrubber}>
            <span className={styles.tfTick}>1h</span>
            <span className={`${styles.tfTick} ${styles.tfTickActive}`}>4h</span>
            <span className={styles.tfTick}>1d</span>
            <span className={styles.tfTick}>1w</span>
          </div>
          <h4 className={styles.panelH4} style={{ marginTop: 22 }}>Toggle row · indicators</h4>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className={styles.toggleRow} style={{ "--c": "var(--accent)" } as React.CSSProperties}>
              <div className={styles.toggleRowLeft}>
                <span className={styles.swatchLine} />
                <span className={styles.toggleLabel}>VWAP</span>
              </div>
              <span className={`${styles.toggle} ${styles.toggleOn}`} />
            </div>
            <div className={styles.toggleRow} style={{ "--c": "var(--warn)" } as React.CSSProperties}>
              <div className={styles.toggleRowLeft}>
                <span className={styles.swatchLine} />
                <span className={styles.toggleLabel}>EMA-20</span>
                <span className={styles.toggleDesc}>· 20p</span>
              </div>
              <span className={`${styles.toggle} ${styles.toggleOn}`} />
            </div>
            <div className={styles.toggleRow} style={{ "--c": "var(--violet)" } as React.CSSProperties}>
              <div className={styles.toggleRowLeft}>
                <span className={styles.swatchLine} />
                <span className={styles.toggleLabel}>Bollinger</span>
                <span className={styles.toggleDesc}>· σ2</span>
              </div>
              <span className={styles.toggle} />
            </div>
          </div>
        </div>
      </div>

      {/* Mark + Composer */}
      <div className={styles.grid2} style={{ marginTop: 18 }}>
        <div className={styles.panel} style={{ padding: 0, overflow: "hidden" }}>
          <h4 className={styles.panelH4} style={{ padding: "24px 24px 0" }}>Price mark</h4>
          <div className={styles.demoMark}>
            <div className={styles.priceMarkLine} />
            <div className={styles.priceMarkTag}>
              <span className={styles.led} />
              <span>$174.20</span>
              <span className={styles.priceMarkNote}>resistance · prev high</span>
            </div>
            <div className={styles.rightTag}>+1.04%</div>
          </div>
        </div>
        <div className={styles.panel} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <h4 className={styles.panelH4}>Mark composer</h4>
          <div className={styles.markComposer}>
            <div className={styles.markComposerRow1}>
              <span>$174.20</span>
              <div className={styles.swatches}>
                <span className={`${styles.swMini} ${styles.swMiniSelected}`} style={{ "--c": "var(--up)" } as React.CSSProperties} />
                <span className={styles.swMini} style={{ "--c": "var(--down)" } as React.CSSProperties} />
                <span className={styles.swMini} style={{ "--c": "var(--warn)" } as React.CSSProperties} />
                <span className={styles.swMini} style={{ "--c": "var(--accent)" } as React.CSSProperties} />
                <span className={styles.swMini} style={{ "--c": "var(--violet)" } as React.CSSProperties} />
              </div>
            </div>
            <textarea className={styles.markTextarea} defaultValue="resistance · prev high" placeholder="Note this level…" />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="t-mono-sm" style={{ color: "var(--ink-3)" }}>cancel</span>
              <button className={styles.primaryBtn}>Save</button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// §05 Agentic
// ---------------------------------------------------------------------------

function AgenticSection() {
  return (
    <section className={styles.section}>
      <SectionHead
        num="05"
        title="Agentic"
        sub="aurora · trace · strategy nodes"
      />
      <div className={styles.grid2}>
        <div className={styles.panel}>
          <h4 className={styles.panelH4}>Avatar · aurora</h4>
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <div className={styles.avatar}><div className={styles.aurora} /></div>
            <div className={styles.avatar}><div className={`${styles.aurora} ${styles.auroraViolet}`} /></div>
            <div>
              <div className="t-h2" style={{ color: "var(--ink-0)" }}>Co-research</div>
              <div className="t-mono-sm">spinning aurora · 6s loop</div>
            </div>
          </div>
          <h4 className={styles.panelH4} style={{ marginTop: 26 }}>Composer</h4>
          <div className={styles.composerRow}>
            <input placeholder="Ask the desk…" />
            <button className={styles.agSend}>↑</button>
          </div>
        </div>

        <div className={styles.panel} style={{ padding: 0 }}>
          <h4 className={styles.panelH4} style={{ padding: "24px 24px 0" }}>Trace · live → done</h4>
          <div className={styles.trace}>
            <div className={`${styles.traceRow} ${styles.traceRowDone}`}>
              <span className={styles.traceBullet}>✓</span>
              <span>Pulled SPY 1H from Polygon</span>
              <span className={styles.traceDetail}>240ms</span>
            </div>
            <div className={`${styles.traceRow} ${styles.traceRowDone}`}>
              <span className={styles.traceBullet}>✓</span>
              <span>Computed VWAP, EMA-20, RSI</span>
              <span className={styles.traceDetail}>82ms</span>
            </div>
            <div className={`${styles.traceRow} ${styles.traceRowLive}`}>
              <span className={styles.traceBullet}><span className={styles.traceSpin} /></span>
              <span>Searching news · last 6h</span>
              <span className={styles.traceDetail}>streaming…</span>
            </div>
            <div className={`${styles.traceRow} ${styles.traceRowPending}`}>
              <span className={styles.traceBullet}><span className={styles.traceDot} /></span>
              <span>Hypothesize regime shift</span>
              <span className={styles.traceDetail}>queued</span>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.panel} style={{ marginTop: 18, padding: 0 }}>
        <h4 className={styles.panelH4} style={{ padding: "24px 24px 0" }}>
          Strategy flow · trigger → filter → entry → exit
        </h4>
        <div className={styles.stratFlow}>
          <div className={`${styles.stratNode} ${styles.stratTrigger}`}>
            <span className={styles.snBadge}>T</span>
            <span className={styles.snBody}>
              <span className={styles.snKind}>trigger</span>
              <span className={styles.snLabel}>RSI &lt; 30</span>
            </span>
          </div>
          <span className={styles.stratEdge}>→</span>
          <div className={`${styles.stratNode} ${styles.stratFilter}`}>
            <span className={styles.snBadge}>F</span>
            <span className={styles.snBody}>
              <span className={styles.snKind}>filter</span>
              <span className={styles.snLabel}>VWAP reclaim</span>
            </span>
          </div>
          <span className={styles.stratEdge}>→</span>
          <div className={`${styles.stratNode} ${styles.stratEntry}`}>
            <span className={styles.snBadge}>E</span>
            <span className={styles.snBody}>
              <span className={styles.snKind}>entry</span>
              <span className={styles.snLabel}>market · 2% size</span>
            </span>
          </div>
          <span className={styles.stratEdge}>→</span>
          <div className={`${styles.stratNode} ${styles.stratExit}`}>
            <span className={styles.snBadge}>X</span>
            <span className={styles.snBody}>
              <span className={styles.snKind}>exit</span>
              <span className={styles.snLabel}>+1.5R / −0.8R</span>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// §06 Principles
// ---------------------------------------------------------------------------

const PRINCIPLES = [
  {
    n: "01",
    title: "Glass over chrome.",
    body: "Surfaces float over the chart on backdrop-filter and color-mix tints — never opaque cards. Inset white-10% highlight on top, deep black drop below.",
  },
  {
    n: "02",
    title: "Mono for numbers.",
    body: "Geist Mono with tabular-nums for every price, delta, timestamp and key. Sans only for prose, labels, and conversational agent copy.",
  },
  {
    n: "03",
    title: "Color = signal.",
    body: "Hue is reserved: green = bull, red = bear, cyan = interactive, amber = warn, violet = agentic. Surfaces stay neutral so signals ring out.",
  },
  {
    n: "04",
    title: "Glow, not stroke.",
    body: "Active state is a soft halo — box-shadow and color-mix, never thick borders. Hairlines stay at white 8%/14% and let glass do the lifting.",
  },
  {
    n: "05",
    title: "Spring on intent.",
    body: "User-driven motion uses ease-spring (overshoot 1.56). Ambient transitions use ease (.22, 1, .36, 1). Live data fades — never slides.",
  },
  {
    n: "06",
    title: "Cinematic, not noisy.",
    body: "A starfield, two color washes, and a 1.5% scanline overlay carry the mood. No gradients on UI; atmosphere lives in the backdrop alone.",
  },
] as const;

function PrinciplesSection() {
  return (
    <section className={styles.section}>
      <SectionHead num="06" title="Principles" sub="the rules behind the look" />
      <div className={styles.grid3}>
        {PRINCIPLES.map((p) => (
          <div key={p.n} className={styles.panel}>
            <div className="t-eyebrow" style={{ marginBottom: 12 }}>— {p.n}</div>
            <div className="t-h1" style={{ fontSize: 22, marginBottom: 10 }}>{p.title}</div>
            <p className="t-body">{p.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Root export
// ---------------------------------------------------------------------------

export default function DesignPreview() {
  return (
    <div className={styles.page}>
      <header className={styles.dsHeader}>
        <div>
          <div className={styles.dsEyebrow}>autoplot · Design System</div>
          <h1 className={styles.dsTitle}>
            Cinematic Dark Glass<br />
            <em>tokens, surfaces &amp; signals.</em>
          </h1>
        </div>
        <div className={styles.dsMeta}>
          v1.0 · 2026<br />
          <span className={styles.dsMetaV}>Geist / Geist Mono</span><br />
          <span className={styles.dsMetaV}>oklch + color-mix</span>
        </div>
      </header>

      <ColorSection />
      <TypeSection />
      <FormSection />
      <ComponentsSection />
      <AgenticSection />
      <PrinciplesSection />

      <footer className={styles.dsFoot}>
        <span>TRADING PORTAL · DESIGN SYSTEM</span>
        <span>v1.0 · cinematic dark glass</span>
      </footer>
    </div>
  );
}
