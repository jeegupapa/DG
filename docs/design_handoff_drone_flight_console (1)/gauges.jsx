/* ==========================================================================
   gauges.jsx — 캔버스/DOM 계기 컴포넌트
   모든 캔버스 계기는 window.DroneSim.state 를 직접 읽어 60fps 로 갱신하고,
   텍스트 리드아웃만 React 상태(120ms 주기)로 갱신한다.
   ========================================================================== */
const { useRef, useEffect, useState, useCallback } = React;

const GS = {
  ink: '#1b2a38', sub: '#5d6f7e', faint: '#93a3b0',
  line: 'rgba(27,42,56,.14)', panel: '#ffffff', accent: '#1f74d8',
  ok: '#1d8a5f', warn: '#b8791a', crit: '#c0392b'
};

function useCanvas(draw, fps) {
  const ref = useRef(null);
  useEffect(() => {
    let last = 0, interval = fps ? 1000 / fps : 0, errs = 0;
    const fn = (dtMs, now) => {
      if (interval && now - last < interval) return;
      last = now;
      const cv = ref.current;
      if (!cv || !cv.clientWidth || !cv.clientHeight) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cv.clientWidth, cv.clientHeight);
      try { draw(ctx, cv.clientWidth, cv.clientHeight, now); }
      catch (e) {
        errs++;
        if (errs < 3) console.error('[draw]', e && e.message);
        if (errs === 3) window.Tick.remove(fn);
      }
    };
    window.Tick.add(fn);
    return () => window.Tick.remove(fn);
  }, [draw, fps]);
  return ref;
}

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ---- 인공 수평계 ------------------------------------------------------ */
function Attitude() {
  const draw = useCallback((ctx, W, H) => {
    const d = window.DroneSim.state;
    const accent = window.SimU.accent;
    const cx = W / 2, cy = H / 2;
    const ppd = H / 62;
    ctx.save();
    rrect(ctx, 0, 0, W, H, 6); ctx.clip();
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-d.roll * Math.PI / 180);
    const off = d.pitch * ppd;
    // 하늘
    let g = ctx.createLinearGradient(0, -H, 0, off);
    g.addColorStop(0, 'hsl(206 72% 90%)');
    g.addColorStop(1, 'hsl(203 62% 84%)');
    ctx.fillStyle = g;
    ctx.fillRect(-W * 1.5, -H * 2 + off, W * 3, H * 2);
    // 지면
    g = ctx.createLinearGradient(0, off, 0, H);
    g.addColorStop(0, 'hsl(36 30% 72%)');
    g.addColorStop(1, 'hsl(32 26% 60%)');
    ctx.fillStyle = g;
    ctx.fillRect(-W * 1.5, off, W * 3, H * 2);
    ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(-W * 1.5, off); ctx.lineTo(W * 1.5, off); ctx.stroke();
    // 피치 래더
    ctx.font = '600 9px "IBM Plex Mono", monospace';
    ctx.textBaseline = 'middle';
    for (let p = -30; p <= 30; p += 5) {
      if (p === 0) continue;
      const y = off - p * ppd;
      const major = p % 10 === 0;
      const wdt = major ? 46 : 24;
      ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(-wdt, y); ctx.lineTo(-9, y);
      ctx.moveTo(9, y); ctx.lineTo(wdt, y);
      ctx.stroke();
      if (major) {
        ctx.fillStyle = 'rgba(255,255,255,.95)';
        ctx.textAlign = 'right'; ctx.fillText(String(Math.abs(p)), -wdt - 4, y);
        ctx.textAlign = 'left'; ctx.fillText(String(Math.abs(p)), wdt + 4, y);
      }
    }
    ctx.restore();

    // 롤 눈금 (고정)
    ctx.save();
    ctx.translate(cx, cy);
    const R = Math.min(W, H) * 0.46;
    ctx.strokeStyle = 'rgba(27,42,56,.35)'; ctx.lineWidth = 1;
    for (let a = -60; a <= 60; a += 10) {
      const rad = (a - 90) * Math.PI / 180;
      const l = a % 30 === 0 ? 8 : 4;
      ctx.beginPath();
      ctx.moveTo(Math.cos(rad) * R, Math.sin(rad) * R);
      ctx.lineTo(Math.cos(rad) * (R + l), Math.sin(rad) * (R + l));
      ctx.stroke();
    }
    // 롤 포인터
    const rr = (d.roll - 90) * Math.PI / 180;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(Math.cos(rr) * R, Math.sin(rr) * R);
    ctx.lineTo(Math.cos(rr - 0.12) * (R - 9), Math.sin(rr - 0.12) * (R - 9));
    ctx.lineTo(Math.cos(rr + 0.12) * (R - 9), Math.sin(rr + 0.12) * (R - 9));
    ctx.closePath(); ctx.fill();
    // 기체 심볼
    ctx.strokeStyle = accent; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-30, 0); ctx.lineTo(-11, 0);
    ctx.moveTo(11, 0); ctx.lineTo(30, 0);
    ctx.moveTo(-11, 0); ctx.lineTo(-11, 5);
    ctx.moveTo(11, 0); ctx.lineTo(11, 5);
    ctx.stroke();
    ctx.fillStyle = accent;
    ctx.beginPath(); ctx.arc(0, 0, 2, 0, 7); ctx.fill();
    ctx.restore();
    // 수치
    ctx.font = '700 11px "IBM Plex Mono", monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = GS.ink;
    ctx.fillText('P ' + (d.pitch >= 0 ? '+' : '') + d.pitch.toFixed(1) + '\u00b0', 8, 7);
    ctx.textAlign = 'right';
    ctx.fillText('R ' + (d.roll >= 0 ? '+' : '') + d.roll.toFixed(1) + '\u00b0', W - 8, 7);
    ctx.restore();
    ctx.strokeStyle = GS.line; ctx.lineWidth = 1;
    rrect(ctx, 0.5, 0.5, W - 1, H - 1, 6); ctx.stroke();
  }, []);
  const ref = useCanvas(draw, 0);
  return <canvas ref={ref} className="cv-fill" />;
}

/* ---- 고도 테이프 ------------------------------------------------------ */
function AltTape() {
  const draw = useCallback((ctx, W, H) => {
    const d = window.DroneSim.state;
    const accent = window.SimU.accent;
    const mPerPx = 0.42;
    const cx = W - 34;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    ctx.font = '600 9.5px "IBM Plex Mono", monospace';
    ctx.textBaseline = 'middle';
    const half = (H / 2) * mPerPx;
    const top = d.alt + half, bot = d.alt - half;
    const start = Math.ceil(bot / 5) * 5;
    for (let m = start; m <= top; m += 5) {
      const y = H / 2 - (m - d.alt) / mPerPx;
      const major = m % 25 === 0;
      ctx.strokeStyle = major ? 'rgba(27,42,56,.55)' : 'rgba(27,42,56,.22)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, y); ctx.lineTo(cx + (major ? 16 : 8), y); ctx.stroke();
      if (major) {
        ctx.fillStyle = GS.sub; ctx.textAlign = 'right';
        ctx.fillText(String(m), cx - 5, y);
      }
    }
    // 목표 고도 마커
    const ty = H / 2 - (d.targetAlt - d.alt) / mPerPx;
    if (ty > -10 && ty < H + 10) {
      ctx.fillStyle = 'rgba(184,121,26,.85)';
      ctx.beginPath();
      ctx.moveTo(cx + 18, ty); ctx.lineTo(cx + 30, ty - 5); ctx.lineTo(cx + 30, ty + 5);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(184,121,26,.45)'; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(0, ty); ctx.lineTo(cx + 18, ty); ctx.stroke();
      ctx.setLineDash([]);
    }
    // 포인터
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(cx - 2, H / 2); ctx.lineTo(cx - 12, H / 2 - 7); ctx.lineTo(cx - 12, H / 2 + 7);
    ctx.closePath(); ctx.fill();
    // 현재값 박스
    const txt = window.SimUtil.alt(d.alt).toFixed(1);
    ctx.font = '700 15px "IBM Plex Mono", monospace';
    const tw = ctx.measureText(txt).width;
    ctx.fillStyle = accent;
    rrect(ctx, 0, H / 2 - 13, tw + 14, 26, 4); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
    ctx.fillText(txt, 7, H / 2 + 0.5);
    ctx.strokeStyle = GS.line;
    ctx.beginPath(); ctx.moveTo(cx - 0.5, 0); ctx.lineTo(cx - 0.5, H); ctx.stroke();
  }, []);
  const ref = useCanvas(draw, 0);
  return <canvas ref={ref} className="cv-fill" />;
}

/* ---- 속도 테이프 (수평) ----------------------------------------------- */
function SpeedTape() {
  const draw = useCallback((ctx, W, H) => {
    const d = window.DroneSim.state;
    const accent = window.SimU.accent;
    const max = 18;
    const px = (W - 8) / max;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    const y = H - 16;
    ctx.strokeStyle = GS.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(4, y + 0.5); ctx.lineTo(W - 4, y + 0.5); ctx.stroke();
    ctx.font = '600 9px "IBM Plex Mono", monospace';
    ctx.textBaseline = 'top'; ctx.textAlign = 'center';
    for (let v = 0; v <= max; v += 3) {
      const x = 4 + v * px;
      ctx.strokeStyle = 'rgba(27,42,56,.3)';
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 5); ctx.stroke();
      ctx.fillStyle = GS.faint; ctx.fillText(String(v), x, y + 7);
    }
    // 채움
    const bw = Math.min(W - 8, d.vh * px);
    const g = ctx.createLinearGradient(0, 0, 0, y);
    g.addColorStop(0, accent); g.addColorStop(1, accent + '55');
    ctx.fillStyle = g;
    rrect(ctx, 4, y - 12, Math.max(2, bw), 11, 3); ctx.fill();
    // 현재값
    ctx.font = '700 15px "IBM Plex Mono", monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = GS.ink;
    ctx.fillText(window.SimUtil.spd(d.vh).toFixed(1), 6, 2);
    ctx.font = '600 10px "IBM Plex Mono", monospace';
    ctx.fillStyle = GS.faint;
    ctx.fillText(window.SimUtil.spdU(), 6 + ctx.measureText('').width + 40, 6);
    ctx.textAlign = 'right';
    ctx.fillStyle = GS.sub;
    ctx.fillText('VSI ' + (d.vv >= 0 ? '+' : '') + d.vv.toFixed(1) + ' m/s', W - 6, 6);
  }, []);
  const ref = useCanvas(draw, 0);
  return <canvas ref={ref} className="cv-fill" />;
}

/* ---- 이력 차트 -------------------------------------------------------- */
function HistoryChart() {
  const draw = useCallback((ctx, W, H) => {
    const d = window.DroneSim.state;
    const accent = window.SimU.accent;
    const h = d.hist;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    const padL = 26, padR = 8, padT = 8, padB = 14;
    const cw = W - padL - padR, ch = H - padT - padB;
    ctx.font = '600 8.5px "IBM Plex Mono", monospace';
    ctx.textBaseline = 'middle';
    // 고도 눈금
    const maxAlt = Math.max(60, Math.ceil(d.maxAlt / 20) * 20 + 20);
    for (let i = 0; i <= 4; i++) {
      const v = maxAlt * i / 4;
      const y = padT + ch - (v / maxAlt) * ch;
      ctx.strokeStyle = 'rgba(27,42,56,.08)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.fillStyle = GS.faint; ctx.textAlign = 'right';
      ctx.fillText(String(Math.round(v)), padL - 4, y);
    }
    if (h.length > 1) {
      const t0 = h[0].t, t1 = Math.max(h[h.length - 1].t, t0 + 30);
      const X = (t) => padL + ((t - t0) / (t1 - t0)) * cw;
      // 고도 영역
      ctx.beginPath();
      ctx.moveTo(X(h[0].t), padT + ch);
      for (let i = 0; i < h.length; i++) ctx.lineTo(X(h[i].t), padT + ch - (h[i].alt / maxAlt) * ch);
      ctx.lineTo(X(h[h.length - 1].t), padT + ch);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, padT, 0, padT + ch);
      g.addColorStop(0, accent + '44'); g.addColorStop(1, accent + '08');
      ctx.fillStyle = g; ctx.fill();
      ctx.beginPath();
      for (let i = 0; i < h.length; i++) {
        const x = X(h[i].t), y = padT + ch - (h[i].alt / maxAlt) * ch;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.strokeStyle = accent; ctx.lineWidth = 1.7; ctx.stroke();
      // 속도
      const maxS = 65;
      ctx.beginPath();
      for (let i = 0; i < h.length; i++) {
        const x = X(h[i].t), y = padT + ch - (Math.min(maxS, h[i].spd) / maxS) * ch;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.strokeStyle = 'rgba(29,138,95,.85)'; ctx.lineWidth = 1.3;
      ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
      // 배터리
      ctx.beginPath();
      for (let i = 0; i < h.length; i++) {
        const x = X(h[i].t), y = padT + ch - (h[i].bat / 100) * ch;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.strokeStyle = 'rgba(184,121,26,.6)'; ctx.lineWidth = 1.1; ctx.stroke();
      ctx.fillStyle = GS.faint; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText('-' + Math.round(t1 - t0) + 's', padL, H - 2);
      ctx.textAlign = 'right';
      ctx.fillText('now', W - padR, H - 2);
    } else {
      ctx.fillStyle = GS.faint; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '600 10px "IBM Plex Mono", monospace';
      ctx.fillText('데이터 수집 대기', W / 2, H / 2);
    }
    ctx.strokeStyle = GS.line;
    ctx.beginPath(); ctx.moveTo(padL - 0.5, padT); ctx.lineTo(padL - 0.5, padT + ch); ctx.stroke();
  }, []);
  const ref = useCanvas(draw, 12);
  return <canvas ref={ref} className="cv-fill" />;
}

/* ---- 조이스틱 -------------------------------------------------------- */
function Joystick({ axis, label, sub, onChange }) {
  const ref = useRef(null);
  const [pos, setPos] = useState([0, 0]);
  const dragging = useRef(false);
  const apply = useCallback((cx, cy) => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    let x = ((cx - r.left) / r.width) * 2 - 1;
    let y = ((cy - r.top) / r.height) * 2 - 1;
    const m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    setPos([x, y]);
    onChange(axis, x, y);
  }, [axis, onChange]);
  const down = (e) => {
    dragging.current = true;
    ref.current.setPointerCapture(e.pointerId);
    apply(e.clientX, e.clientY);
  };
  const move = (e) => { if (dragging.current) apply(e.clientX, e.clientY); };
  const up = () => {
    if (!dragging.current) return;
    dragging.current = false;
    setPos([0, 0]); onChange(axis, 0, 0);
  };
  return (
    <div className="joy-wrap">
      <div className="joy" ref={ref}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <div className="joy-ring" />
        <div className="joy-cross-h" /><div className="joy-cross-v" />
        <div className="joy-knob" style={{ left: (50 + pos[0] * 34) + '%', top: (50 + pos[1] * 34) + '%' }} />
      </div>
      <div className="joy-lbl"><b>{label}</b><span>{sub}</span></div>
    </div>
  );
}

/* ---- 작은 부품들 ----------------------------------------------------- */
function Readout({ label, value, unit, sub, tone }) {
  return (
    <div className={'ro' + (tone ? ' ro-' + tone : '')}>
      <div className="ro-l">{label}</div>
      <div className="ro-v"><span>{value}</span><i>{unit}</i></div>
      {sub && <div className="ro-s">{sub}</div>}
    </div>
  );
}

function Bar({ value, max, tone, label, right }) {
  const pct = Math.max(0, Math.min(1, value / max)) * 100;
  return (
    <div className="bar-row">
      <div className="bar-l"><span>{label}</span><b>{right}</b></div>
      <div className="bar"><i className={'bar-f' + (tone ? ' bar-' + tone : '')} style={{ width: pct + '%' }} /></div>
    </div>
  );
}

function Lamp({ tone, children }) {
  return <div className={'lamp lamp-' + tone}><i />{children}</div>;
}

Object.assign(window, { GS, useCanvas, rrect, Attitude, AltTape, SpeedTape, HistoryChart, Joystick, Readout, Bar, Lamp });
