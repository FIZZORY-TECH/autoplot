// ============ Chart canvas ============
// Renders OHLC data in 5 styles with smooth morphing between assets and types.

const { useEffect, useRef, useState, useCallback, useMemo } = React;

function lerp(a, b, t) { return a + (b - a) * t; }

function useAnimatedRange(target) {
  // Smoothly interpolates [lo, hi] over time
  const ref = useRef(target);
  const [, force] = useState(0);
  useEffect(() => {
    let raf;
    const tick = () => {
      const cur = ref.current;
      const dx = target[0] - cur[0];
      const dy = target[1] - cur[1];
      if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) {
        ref.current = target.slice();
        force(n => n + 1);
        return;
      }
      ref.current = [cur[0] + dx * 0.18, cur[1] + dy * 0.18];
      force(n => n + 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target[0], target[1]]);
  return ref.current;
}

function Chart({
  asset, candles, type, viewport, setViewport,
  marks, onChartClick, overlays, customSeries,
  onCrosshairChange, tool,
  aiOverlay, aiSignals,
}) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const dprRef = useRef(window.devicePixelRatio || 1);
  const [size, setSize] = useState({ w: 1, h: 1 });
  const [crosshair, setCrosshair] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [rangeSel, setRangeSel] = useState(null); // { startX, endX } in px
  const [committedRange, setCommittedRange] = useState(null);
  const pinchRef = useRef(null);

  // Responsive sizing
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Visible window
  const visibleData = useMemo(() => {
    if (!candles?.length) return [];
    const start = Math.max(0, Math.floor(viewport.start));
    const end = Math.min(candles.length, Math.ceil(viewport.end));
    return candles.slice(start, end);
  }, [candles, viewport.start, viewport.end]);

  // Y range target (animated for smooth asset switches)
  const targetYRange = useMemo(() => {
    if (!visibleData.length) return [0, 1];
    let lo = Infinity, hi = -Infinity;
    for (const c of visibleData) {
      if (c.l < lo) lo = c.l;
      if (c.h > hi) hi = c.h;
    }
    // Include overlay extremes
    if (overlays?.bb && overlays.bb.upper) {
      const sIdx = Math.max(0, Math.floor(viewport.start));
      const eIdx = Math.min(candles.length, Math.ceil(viewport.end));
      for (let i = sIdx; i < eIdx; i++) {
        const u = overlays.bb.upper[i], l = overlays.bb.lower[i];
        if (isFinite(u) && u > hi) hi = u;
        if (isFinite(l) && l < lo) lo = l;
      }
    }
    if (customSeries) {
      const sIdx = Math.max(0, Math.floor(viewport.start));
      const eIdx = Math.min(customSeries.length, Math.ceil(viewport.end));
      for (let i = sIdx; i < eIdx; i++) {
        const v = customSeries[i];
        if (isFinite(v)) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    if (aiOverlay && aiOverlay.series) {
      const sIdx = Math.max(0, Math.floor(viewport.start));
      const eIdx = Math.min(aiOverlay.series.length, Math.ceil(viewport.end));
      for (let i = sIdx; i < eIdx; i++) {
        const v = aiOverlay.series[i];
        if (isFinite(v)) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    const pad = (hi - lo) * 0.10 || hi * 0.02 || 1;
    return [lo - pad, hi + pad];
  }, [visibleData, overlays, customSeries, aiOverlay, candles, viewport.start, viewport.end]);

  const animatedY = useAnimatedRange(targetYRange);

  // Left/right axis padding in px
  const padR = 60, padB = 22, padT = 16, padL = 12;
  const plotW = Math.max(1, size.w - padR - padL);
  const plotH = Math.max(1, size.h - padB - padT);

  const xToPx = useCallback((i) => {
    const span = viewport.end - viewport.start;
    return padL + ((i - viewport.start) / span) * plotW;
  }, [viewport.start, viewport.end, plotW]);
  const pxToX = useCallback((px) => {
    const span = viewport.end - viewport.start;
    return viewport.start + ((px - padL) / plotW) * span;
  }, [viewport.start, viewport.end, plotW]);
  const yToPx = useCallback((p) => {
    const [lo, hi] = animatedY;
    return padT + (1 - (p - lo) / (hi - lo)) * plotH;
  }, [animatedY, plotH]);
  const pxToY = useCallback((px) => {
    const [lo, hi] = animatedY;
    return lo + (1 - (px - padT) / plotH) * (hi - lo);
  }, [animatedY, plotH]);

  // Draw
  useEffect(() => {
    const cnv = canvasRef.current;
    if (!cnv) return;
    const dpr = dprRef.current;
    cnv.width = Math.floor(size.w * dpr);
    cnv.height = Math.floor(size.h * dpr);
    const ctx = cnv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);

    // Background grid (very subtle)
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    const [lo, hi] = animatedY;
    const range = hi - lo;
    const niceStep = (() => {
      const target = range / 6;
      const pow = Math.pow(10, Math.floor(Math.log10(target)));
      const m = target / pow;
      const ms = m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10;
      return ms * pow;
    })();
    const first = Math.ceil(lo / niceStep) * niceStep;
    for (let v = first; v <= hi; v += niceStep) {
      const y = yToPx(v);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
    }
    ctx.restore();

    if (!candles?.length) return;
    const sIdx = Math.max(0, Math.floor(viewport.start));
    const eIdx = Math.min(candles.length, Math.ceil(viewport.end) + 1);
    const span = viewport.end - viewport.start;
    const cw = (plotW / span) * 0.72;

    const upColor = 'oklch(0.78 0.16 150)';
    const downColor = 'oklch(0.70 0.20 25)';

    if (type === 'candles' || type === 'heikin') {
      for (let i = sIdx; i < eIdx; i++) {
        const c = candles[i];
        const x = xToPx(i + 0.5);
        const oy = yToPx(c.o), cy = yToPx(c.c), hy = yToPx(c.h), ly = yToPx(c.l);
        const up = c.c >= c.o;
        ctx.strokeStyle = up ? upColor : downColor;
        ctx.fillStyle = up ? upColor : downColor;
        ctx.lineWidth = 1;
        // wick
        ctx.beginPath();
        ctx.moveTo(x, hy);
        ctx.lineTo(x, ly);
        ctx.stroke();
        // body
        const bodyTop = Math.min(oy, cy);
        const bodyH = Math.max(1, Math.abs(cy - oy));
        ctx.fillRect(x - cw / 2, bodyTop, cw, bodyH);
      }
    } else if (type === 'bars') {
      for (let i = sIdx; i < eIdx; i++) {
        const c = candles[i];
        const x = xToPx(i + 0.5);
        const oy = yToPx(c.o), cy = yToPx(c.c), hy = yToPx(c.h), ly = yToPx(c.l);
        const up = c.c >= c.o;
        ctx.strokeStyle = up ? upColor : downColor;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(x, hy); ctx.lineTo(x, ly); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x - cw/2, oy); ctx.lineTo(x, oy); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(x + cw/2, cy); ctx.stroke();
      }
    } else if (type === 'line') {
      ctx.strokeStyle = 'oklch(0.85 0.06 215)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      let first = true;
      for (let i = sIdx; i < eIdx; i++) {
        const x = xToPx(i + 0.5);
        const y = yToPx(candles[i].c);
        if (first) { ctx.moveTo(x, y); first = false; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else if (type === 'area') {
      const grd = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      grd.addColorStop(0, 'color-mix(in oklab, oklch(0.82 0.14 215) 40%, transparent)');
      grd.addColorStop(1, 'color-mix(in oklab, oklch(0.82 0.14 215) 0%, transparent)');
      // canvas doesn't support color-mix in gradients; fall back
      const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      grad.addColorStop(0, 'rgba(140, 200, 230, 0.35)');
      grad.addColorStop(1, 'rgba(140, 200, 230, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      const xs = xToPx(sIdx + 0.5);
      ctx.moveTo(xs, padT + plotH);
      let lastX = xs;
      for (let i = sIdx; i < eIdx; i++) {
        const x = xToPx(i + 0.5);
        const y = yToPx(candles[i].c);
        ctx.lineTo(x, y);
        lastX = x;
      }
      ctx.lineTo(lastX, padT + plotH);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'oklch(0.85 0.06 215)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      let first = true;
      for (let i = sIdx; i < eIdx; i++) {
        const x = xToPx(i + 0.5);
        const y = yToPx(candles[i].c);
        if (first) { ctx.moveTo(x, y); first = false; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else if (type === 'mountain') {
      // novel: dotted columns scaled by close
      for (let i = sIdx; i < eIdx; i++) {
        const c = candles[i];
        const x = xToPx(i + 0.5);
        const cy = yToPx(c.c);
        const up = i === 0 || c.c >= candles[i-1].c;
        ctx.fillStyle = up ? 'rgba(120, 220, 170, 0.7)' : 'rgba(240, 130, 110, 0.7)';
        ctx.fillRect(x - 1, cy, 2, padT + plotH - cy);
      }
    }

    // overlays
    const drawSeries = (series, color, lw = 1.4) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.beginPath();
      let started = false;
      for (let i = sIdx; i < eIdx; i++) {
        const v = series[i];
        if (!isFinite(v)) { started = false; continue; }
        const x = xToPx(i + 0.5);
        const y = yToPx(v);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    if (overlays?.ma20) drawSeries(overlays.ma20, 'oklch(0.85 0.14 80)', 1.2);
    if (overlays?.ma50) drawSeries(overlays.ma50, 'oklch(0.78 0.14 280)', 1.2);
    if (overlays?.bb) {
      drawSeries(overlays.bb.upper, 'rgba(180,200,230,0.35)', 1);
      drawSeries(overlays.bb.lower, 'rgba(180,200,230,0.35)', 1);
      // fill between
      ctx.fillStyle = 'rgba(180,200,230,0.05)';
      ctx.beginPath();
      let started = false;
      for (let i = sIdx; i < eIdx; i++) {
        const u = overlays.bb.upper[i];
        if (!isFinite(u)) continue;
        const x = xToPx(i + 0.5), y = yToPx(u);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      for (let i = eIdx - 1; i >= sIdx; i--) {
        const l = overlays.bb.lower[i];
        if (!isFinite(l)) continue;
        const x = xToPx(i + 0.5), y = yToPx(l);
        ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    }
    if (customSeries) {
      drawSeries(customSeries, 'oklch(0.82 0.14 215)', 1.6);
    }
    if (aiOverlay && aiOverlay.series) {
      // glow pass
      ctx.save();
      ctx.shadowBlur = 14;
      ctx.shadowColor = aiOverlay.color;
      drawSeries(aiOverlay.series, aiOverlay.color, 1.8);
      ctx.restore();
    }

    // AI strategy signals — triangles + connector lines for buy/sell pairs
    if (aiSignals && aiSignals.length) {
      // pair buys with subsequent sells for connectors
      let openBuy = null;
      for (const s of aiSignals) {
        const x = xToPx(s.t + 0.5);
        const y = yToPx(s.price);
        if (x < padL || x > padL + plotW) { if (s.side === 'buy') openBuy = { x, y, price: s.price }; else openBuy = null; continue; }
        if (s.side === 'buy') {
          if (openBuy) {
            // shouldn't happen but reset
          }
          openBuy = { x, y, price: s.price };
          // upward triangle
          ctx.fillStyle = 'oklch(0.82 0.18 150)';
          ctx.strokeStyle = 'rgba(0,0,0,0.4)';
          ctx.beginPath();
          ctx.moveTo(x, y + 6);
          ctx.lineTo(x - 6, y + 16);
          ctx.lineTo(x + 6, y + 16);
          ctx.closePath(); ctx.fill();
        } else if (s.side === 'sell') {
          // connector line if we have an open buy
          if (openBuy) {
            const profitable = s.price >= openBuy.price;
            ctx.save();
            ctx.strokeStyle = profitable ? 'rgba(140, 220, 170, 0.55)' : 'rgba(240, 130, 110, 0.55)';
            ctx.setLineDash([4, 4]);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(openBuy.x, openBuy.y);
            ctx.lineTo(x, y);
            ctx.stroke();
            ctx.restore();
            openBuy = null;
          }
          // downward triangle
          ctx.fillStyle = 'oklch(0.78 0.20 25)';
          ctx.beginPath();
          ctx.moveTo(x, y - 6);
          ctx.lineTo(x - 6, y - 16);
          ctx.lineTo(x + 6, y - 16);
          ctx.closePath(); ctx.fill();
        }
      }
    }

    // last-price horizontal guide
    const last = candles[candles.length - 1];
    if (last) {
      const ly = yToPx(last.c);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, ly); ctx.lineTo(padL + plotW, ly);
      ctx.stroke();
      ctx.restore();
    }

    // crosshair
    if (crosshair) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.24)';
      ctx.setLineDash([1, 3]);
      ctx.beginPath();
      ctx.moveTo(crosshair.x, padT);
      ctx.lineTo(crosshair.x, padT + plotH);
      ctx.moveTo(padL, crosshair.y);
      ctx.lineTo(padL + plotW, crosshair.y);
      ctx.stroke();
      ctx.restore();
    }
  }, [size, candles, type, viewport, animatedY, overlays, customSeries, crosshair, xToPx, yToPx]);

  // Interaction
  const onMove = useCallback((e) => {
    const rect = wrapRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setCrosshair({ x, y });
    const idx = Math.floor(pxToX(x));
    const price = pxToY(y);
    if (idx >= 0 && idx < candles.length) {
      const ch = { idx, price, x, y, candle: candles[idx] };
      onCrosshairChange?.(ch);
    }
    if (dragging?.kind === 'range') {
      setRangeSel({ startX: dragging.startX, endX: x });
    } else if (dragging) {
      const dx = x - dragging.startX;
      const span = dragging.startEnd - dragging.startStart;
      const shift = -(dx / plotW) * span;
      let s = dragging.startStart + shift;
      let e2 = dragging.startEnd + shift;
      if (s < -50) { e2 += -50 - s; s = -50; }
      if (e2 > candles.length + 50) { s -= e2 - (candles.length + 50); e2 = candles.length + 50; }
      setViewport({ start: s, end: e2 });
    }
  }, [pxToX, pxToY, candles, dragging, plotW, setViewport, onCrosshairChange]);

  const onWheel = useCallback((e) => {
    e.preventDefault();
    const rect = wrapRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const focusIdx = pxToX(x);
    const span = viewport.end - viewport.start;
    const scale = e.deltaY > 0 ? 1.1 : 0.9;
    const newSpan = Math.max(20, Math.min(candles.length * 1.2, span * scale));
    const ratio = (focusIdx - viewport.start) / span;
    const start = focusIdx - ratio * newSpan;
    const end = start + newSpan;
    setViewport({ start, end });
  }, [viewport, candles, pxToX, setViewport]);

  const onDown = (e) => {
    if (e.button !== 0) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const isRange = tool === 'range' || e.shiftKey;
    setDragging({
      kind: isRange ? 'range' : 'pan',
      startX: x,
      startStart: viewport.start,
      startEnd: viewport.end,
    });
    if (isRange) { setRangeSel({ startX: x, endX: x }); setCommittedRange(null); }
  };
  const onUp = (e) => {
    if (!dragging) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const moved = Math.abs(x - dragging.startX) > 4;
    if (dragging.kind === 'range' && moved) {
      const a = Math.min(dragging.startX, x), b = Math.max(dragging.startX, x);
      setCommittedRange({ startX: a, endX: b });
      setRangeSel(null);
    } else if (!moved) {
      const idx = Math.floor(pxToX(x));
      const price = pxToY(e.clientY - rect.top);
      onChartClick?.({ idx, price, clientX: e.clientX, clientY: e.clientY });
      setRangeSel(null);
    } else {
      setRangeSel(null);
    }
    setDragging(null);
  };

  // Touch gestures: 1 finger = pan/range, 2 fingers = pinch zoom
  const onTouchStart = (e) => {
    const rect = wrapRef.current.getBoundingClientRect();
    if (e.touches.length === 1) {
      const t = e.touches[0];
      const x = t.clientX - rect.left;
      const isRange = tool === 'range';
      setDragging({ kind: isRange ? 'range' : 'pan', startX: x, startStart: viewport.start, startEnd: viewport.end });
      if (isRange) { setRangeSel({ startX: x, endX: x }); setCommittedRange(null); }
    } else if (e.touches.length === 2) {
      const [a, b] = e.touches;
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const cx = ((a.clientX + b.clientX) / 2) - rect.left;
      pinchRef.current = { dist, cx, span: viewport.end - viewport.start, focusIdx: pxToX(cx), startStart: viewport.start };
      setDragging(null);
    }
  };
  const onTouchMove = (e) => {
    e.preventDefault();
    const rect = wrapRef.current.getBoundingClientRect();
    if (e.touches.length === 2 && pinchRef.current) {
      const [a, b] = e.touches;
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const ratio = pinchRef.current.dist / Math.max(dist, 1);
      const newSpan = Math.max(20, Math.min(candles.length * 1.2, pinchRef.current.span * ratio));
      const focusIdx = pinchRef.current.focusIdx;
      const r = (focusIdx - pinchRef.current.startStart) / pinchRef.current.span;
      const start = focusIdx - r * newSpan;
      setViewport({ start, end: start + newSpan });
    } else if (e.touches.length === 1 && dragging) {
      const t = e.touches[0];
      const x = t.clientX - rect.left;
      const y = t.clientY - rect.top;
      setCrosshair({ x, y });
      if (dragging.kind === 'range') {
        setRangeSel({ startX: dragging.startX, endX: x });
      } else {
        const dx = x - dragging.startX;
        const span = dragging.startEnd - dragging.startStart;
        const shift = -(dx / plotW) * span;
        let s = dragging.startStart + shift;
        let e2 = dragging.startEnd + shift;
        if (s < -50) { e2 += -50 - s; s = -50; }
        if (e2 > candles.length + 50) { s -= e2 - (candles.length + 50); e2 = candles.length + 50; }
        setViewport({ start: s, end: e2 });
      }
    }
  };
  const onTouchEnd = (e) => {
    if (pinchRef.current && e.touches.length < 2) pinchRef.current = null;
    if (dragging) {
      if (dragging.kind === 'range' && rangeSel) {
        const a = Math.min(rangeSel.startX, rangeSel.endX), b = Math.max(rangeSel.startX, rangeSel.endX);
        if (b - a > 6) {
          setCommittedRange({ startX: a, endX: b });
          setRangeSel(null);
        } else { setRangeSel(null); }
      }
      setDragging(null);
    }
    setCrosshair(null);
  };

  // Compute range stats
  const rangeStats = useMemo(() => {
    if (!committedRange) return null;
    const i1 = Math.max(0, Math.min(candles.length - 1, Math.floor(pxToX(committedRange.startX))));
    const i2 = Math.max(0, Math.min(candles.length - 1, Math.floor(pxToX(committedRange.endX))));
    const lo = Math.min(i1, i2), hi = Math.max(i1, i2);
    if (hi <= lo) return null;
    const slice = candles.slice(lo, hi + 1);
    let h = -Infinity, l = Infinity;
    for (const c of slice) { if (c.h > h) h = c.h; if (c.l < l) l = c.l; }
    const open = slice[0].o, close = slice[slice.length - 1].c;
    const chg = (close - open) / open;
    const bars = hi - lo + 1;
    const hours = bars * 4;
    const span = hours < 24 ? `${hours}h` : `${Math.round(hours/24)}d`;
    return { open, close, h, l, chg, bars, span, lo, hi };
  }, [committedRange, candles, pxToX]);

  return (
    <div
      className="chart-stage"
      ref={wrapRef}
      onMouseMove={onMove}
      onMouseLeave={() => setCrosshair(null)}
      onWheel={onWheel}
      onMouseDown={onDown}
      onMouseUp={onUp}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      style={{ cursor: tool === 'range' ? 'ew-resize' : (dragging ? 'grabbing' : 'crosshair'), touchAction: 'none' }}
    >
      <canvas ref={canvasRef} />

      {/* Y-axis ticks */}
      <YAxis range={animatedY} yToPx={yToPx} lastPrice={candles?.[candles.length - 1]?.c} fmt={window.TradingData.fmtPrice} />
      <XAxis viewport={viewport} count={candles?.length ?? 0} xToPx={xToPx} />

      {/* Marks */}
      <div className="marks-layer">
        {marks.map(m => (
          <div
            key={m.id}
            className="price-mark"
            style={{ '--mark-color': m.color, top: yToPx(m.price) }}
          >
            <div className="tag">
              <span className="led" />
              <span className="px">{window.TradingData.fmtPrice(m.price)}</span>
              {m.note ? <span className="note">{m.note}</span> : null}
            </div>
            <div className="right-tag" style={{ background: m.color }}>
              {window.TradingData.fmtPrice(m.price)}
            </div>
          </div>
        ))}
      </div>

      {crosshair && (
        <div className="crosshair-readout" style={{ left: crosshair.x, top: crosshair.y }}>
          {window.TradingData.fmtPrice(pxToY(crosshair.y))}
        </div>
      )}

      {rangeSel && (
        <div
          className="range-sel"
          style={{
            left: Math.min(rangeSel.startX, rangeSel.endX),
            width: Math.abs(rangeSel.endX - rangeSel.startX),
          }}
        />
      )}
      {committedRange && (
        <div
          className="range-sel"
          style={{
            left: committedRange.startX,
            width: committedRange.endX - committedRange.startX,
          }}
        />
      )}
      {rangeStats && committedRange && (
        <div
          className="range-stats"
          style={{
            left: Math.min(window.innerWidth - 240, committedRange.endX + 12),
            top: 70,
          }}
        >
          <button className="close-rs" onClick={() => setCommittedRange(null)}>×</button>
          <span className="k">Δ</span>
          <span className={`v ${rangeStats.chg >= 0 ? 'up' : 'down'}`}>
            {window.TradingData.fmtPct(rangeStats.chg)} · {window.TradingData.fmtPrice(rangeStats.close - rangeStats.open)}
          </span>
          <span className="k">Open</span><span className="v">{window.TradingData.fmtPrice(rangeStats.open)}</span>
          <span className="k">Close</span><span className="v">{window.TradingData.fmtPrice(rangeStats.close)}</span>
          <span className="k">High</span><span className="v">{window.TradingData.fmtPrice(rangeStats.h)}</span>
          <span className="k">Low</span><span className="v">{window.TradingData.fmtPrice(rangeStats.l)}</span>
          <span className="k">Span</span><span className="v">{rangeStats.bars} bars · {rangeStats.span}</span>
        </div>
      )}
    </div>
  );
}

function YAxis({ range, yToPx, lastPrice, fmt }) {
  if (!isFinite(range[0])) return null;
  const [lo, hi] = range;
  const r = hi - lo;
  const step = (() => {
    const target = r / 6;
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const m = target / pow;
    const ms = m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10;
    return ms * pow;
  })();
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
  return (
    <div className="axis-y">
      {ticks.map((v, i) => (
        <div key={i} className="tick" style={{ top: yToPx(v) }}>{fmt(v)}</div>
      ))}
      {isFinite(lastPrice) && (
        <div className="tick live" style={{ top: yToPx(lastPrice) }}>{fmt(lastPrice)}</div>
      )}
    </div>
  );
}

function XAxis({ viewport, count, xToPx }) {
  const span = viewport.end - viewport.start;
  const target = span / 8;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const m = target / pow;
  const ms = m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10;
  const step = ms * pow;
  const ticks = [];
  const start = Math.ceil(viewport.start / step) * step;
  for (let i = start; i <= viewport.end; i += step) ticks.push(i);
  // pretend each candle is a 4h bar; render relative time
  const fmtTick = (i) => {
    const distFromEnd = count - i;
    if (distFromEnd <= 0) return 'now';
    if (distFromEnd < 6) return `-${distFromEnd}h`;
    const d = Math.round(distFromEnd / 6);
    if (d < 30) return `-${d}d`;
    return `-${Math.round(d / 30)}mo`;
  };
  return (
    <div className="axis-x">
      {ticks.map((t, i) => (
        <div key={i} className="tick" style={{ left: xToPx(t) }}>{fmtTick(t)}</div>
      ))}
    </div>
  );
}

window.Chart = Chart;
