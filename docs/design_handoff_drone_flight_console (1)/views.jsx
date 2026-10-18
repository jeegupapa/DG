/* ==========================================================================
   views.jsx — 2D 지도 / 3D 지형 / 짐벌 카메라 뷰 (캔버스)
   ========================================================================== */
const VS = { useRef, useEffect, useState, useCallback };

const VR = {
  ink: '#1b2a38', sub: '#5d6f7e', faint: '#93a3b0', line: 'rgba(27,42,56,.14)',
  accent: '#1f74d8', ok: '#1d8a5f', warn: '#b8791a', crit: '#c0392b'
};

const SHOW_DEF = { showTrail: true, showGrid: true, showMarkers: true, showFence: true };

function PanelHead({ title, code, right, onReset }) {
  return (
    <div className="ph">
      <div className="ph-l">
        <span className="ph-t">{title}</span>
        {code && <span className="ph-c">{code}</span>}
      </div>
      <div className="ph-r">{right}</div>
    </div>
  );
}

/* ---------------- 2D 지도 ---------------- */
function ViewMap({ ppm0 }) {
  const view = VS.useRef({ cx: 0, cz: 0, ppm: ppm0 || 1.5, init: false });
  const cache = VS.useRef(window.DroneRender.newMapCache());
  const follow = VS.useRef(true);
  const drag = VS.useRef(null);
  const [ui, setUi] = VS.useState({ ppm: view.current.ppm, follow: follow.current, center: [0, 0] });
  const fref = VS.useRef(follow); fref.current = follow;

  const draw = VS.useCallback((ctx, W, H) => {
    const d = window.DroneSim.state, S = window.DroneSim.state;
    const v = view.current;
    if (!v.init) { v.cx = d.x; v.cz = d.z; v.init = true; }
    if (fref.current) {
      v.cx += (d.x - v.cx) * 0.16;
      v.cz += (d.z - v.cz) * 0.16;
    }
    window.DroneRender.renderMap(ctx, W, H, {
      cx: v.cx, cz: v.cz, ppm: v.ppm,
      drone: d, waypoints: d.waypoints, wpIdx: d.missionIdx, home: d.home,
      path: d.trail, showTrail: S.showTrail, showGrid: S.showGrid,
      showFence: S.showFence, fence: d.fence, cache: cache.current
    });
  }, []);
  const ref = window.useCanvas(draw, 0);

  const setPpm = (f) => {
    const v = view.current;
    v.ppm = Math.max(0.14, Math.min(5.2, v.ppm * f));
    setUi(u => ({ ...u, ppm: v.ppm }));
  };
  const down = (e) => {
    drag.current = { x: e.clientX, y: e.clientY, cx: view.current.cx, cz: view.current.cz };
    e.currentTarget.setPointerCapture(e.pointerId);
    follow.current = false; setUi(u => ({ ...u, follow: false }));
  };
  const move = (e) => {
    if (!drag.current) return;
    const v = view.current, r = e.currentTarget.getBoundingClientRect();
    v.cx = drag.current.cx - (e.clientX - drag.current.x) / v.ppm;
    v.cz = drag.current.cz - (e.clientY - drag.current.y) / v.ppm;
  };
  const up = () => { drag.current = null; };
  const wheel = (e) => { e.preventDefault(); setPpm(e.deltaY < 0 ? 1.16 : 0.86); };
  VS.useEffect(() => {
    const el = ref.current; if (!el) return;
    const h = (e) => wheel(e);
    el.addEventListener('wheel', h, { passive: false });
    return () => el.removeEventListener('wheel', h);
  });
  VS.useEffect(() => {
    const id = setInterval(() => {
      const d = window.DroneSim.state;
      setUi(u => (Math.abs(u.center[0] - d.x) > 1 || Math.abs(u.center[1] - d.z) > 1
        ? { ...u, center: [d.x, d.z] } : u));
    }, 400);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="view">
      <canvas ref={ref} className="cv-fill cv-map" onPointerDown={down}
        onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      <div className="map-tools">
        <button onClick={() => setPpm(1.25)} title="확대">+</button>
        <button onClick={() => setPpm(0.8)} title="축소">−</button>
        <button className={ui.follow ? 'on' : ''} title="기체 추적"
          onClick={() => { follow.current = !follow.current; setUi(u => ({ ...u, follow: !u.follow })); }}>⌖</button>
      </div>
      <div className="map-hud">
        <span>{window.SimUtil.n(ui.center[0], 0)}, {window.SimUtil.n(ui.center[1], 0)}</span>
        <span className="sep" />
        <span>1:{Math.round(1 / ui.ppm)}</span>
      </div>
    </div>
  );
}

/* ---------------- 3D 지형 ---------------- */
function View3D({ camMode }) {
  const cam = VS.useRef({ a: 200, e: 26, d: 340 });
  const cur = VS.useRef({ a: 200, e: 26, d: 340, tx: 0, ty: 0, tz: 0, init: false });
  const drag = VS.useRef(null);
  const mref = VS.useRef(camMode); mref.current = camMode;

  const draw = VS.useCallback((ctx, W, H) => {
    const d = window.DroneSim.state, S = d, m = mref.current;
    const c = cam.current, k = cur.current;
    const gy = d.groundY + d.alt;
    let ta, te, td;
    if (m === 'chase') { ta = d.yaw + 180; te = 14; td = 92 + d.alt * 1.5; }
    else if (m === 'top') { ta = 180; te = 74; td = 210 + d.alt * 1.3; }
    else { ta = c.a; te = c.e; td = c.d; }
    if (!k.init) { k.a = ta; k.e = te; k.d = td; k.tx = d.x; k.ty = gy; k.tz = d.z; k.init = true; }
    const lp = m === 'orbit' ? 0.12 : 0.09;
    let da = ((ta - k.a + 540) % 360) - 180;
    k.a += da * lp; k.e += (te - k.e) * lp; k.d += (td - k.d) * lp;
    k.tx += (d.x - k.tx) * lp; k.ty += (gy * 0.72 + d.groundY * 0.28 - k.ty) * lp; k.tz += (d.z - k.tz) * lp;

    const ar = k.a * Math.PI / 180, er = k.e * Math.PI / 180;
    const camPos = [
      k.tx + Math.cos(er) * Math.sin(ar) * k.d,
      k.ty + Math.sin(er) * k.d,
      k.tz + Math.cos(er) * Math.cos(ar) * k.d
    ];
    if (camPos[1] < d.groundY + 4) camPos[1] = d.groundY + 4;
    window.DroneRender.renderScene(ctx, W, H, {
      camPos: camPos, target: [k.tx, k.ty, k.tz], fov: 52,
      focus: [d.x, d.z], extent: 300 + d.alt * 2.2, step: 32,
      drone: d, waypoints: d.waypoints, wpIdx: d.missionIdx, home: d.home,
      showMarkers: S.showMarkers, showPath: S.showTrail, path: d.trail, gimbalYaw: 0
    });
  }, []);
  const ref = window.useCanvas(draw, 0);

  const down = (e) => {
    drag.current = { x: e.clientX, y: e.clientY, a: cam.current.a, e: cam.current.e };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e) => {
    if (!drag.current || mref.current !== 'orbit') return;
    cam.current.a = drag.current.a - (e.clientX - drag.current.x) * 0.42;
    cam.current.e = Math.max(6, Math.min(84, drag.current.e + (e.clientY - drag.current.y) * 0.32));
  };
  const up = () => { drag.current = null; };
  VS.useEffect(() => {
    const el = ref.current; if (!el) return;
    const h = (e) => {
      e.preventDefault();
      if (mref.current !== 'orbit') return;
      cam.current.d = Math.max(60, Math.min(1500, cam.current.d * (e.deltaY < 0 ? 0.9 : 1.11)));
    };
    el.addEventListener('wheel', h, { passive: false });
    return () => el.removeEventListener('wheel', h);
  });

  return (
    <div className="view">
      <canvas ref={ref} className="cv-fill" onPointerDown={down}
        onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      <div className="v3-hint">{camMode === 'orbit' ? '드래그 회전 · 휠 줌' : camMode === 'chase' ? '추적 시점 · 기체 후방' : '탑다운 시점'}</div>
    </div>
  );
}

/* ---------------- 짐벌 카메라 뷰 ---------------- */
function ViewCam({ zoom }) {
  const zref = VS.useRef(zoom); zref.current = zoom;
  const draw = VS.useCallback((ctx, W, H) => {
    const d = window.DroneSim.state;
    window.DroneRender.renderCam(ctx, W, H, { drone: d, gimbalYaw: 0, gimbalPitch: d.gimbalPitch, zoom: zref.current });
  }, []);
  const ref = window.useCanvas(draw, 0);
  return <canvas ref={ref} className="cv-fill" />;
}

/* ---------------- 드래그 가능한 PiP ----------------
/* pos 가 없을 때(첫 로드)는 CSS 의 left/bottom 기본 위치로 앵커링된다.
   예전엔 오프셋을 아예 주지 않아 정적 위치(캔버스 아래)로 흘러가
   .view 의 overflow:hidden 에 잘려 보이지 않았다. */
function Pip({ title, size, onCycleSize, children, storageKey }) {
  const [pos, setPos] = VS.useState(null);
  const root = VS.useRef(null);
  const drag = VS.useRef(null);
  VS.useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p && typeof p.x === 'number' && typeof p.y === 'number') setPos(p);
    } catch (e) { }
  }, [storageKey]);

  const hostOf = () => {
    const el = root.current;
    if (!el) return null;
    return el.offsetParent || el.parentElement;
  };

  /* 저장된 위치가 현재 뷰 크기 밖이면 안으로 당긴다(레이아웃 전환·창 축소 대응) */
  VS.useEffect(() => {
    if (!pos) return;
    const el = root.current, host = hostOf();
    if (!el || !host || !host.clientWidth || !host.clientHeight) return;
    const maxX = Math.max(0, (host.clientWidth - el.offsetWidth) / host.clientWidth);
    const maxY = Math.max(0, (host.clientHeight - el.offsetHeight) / host.clientHeight);
    if (pos.x > maxX || pos.y > maxY) {
      const p = { x: Math.min(pos.x, maxX), y: Math.min(pos.y, maxY) };
      setPos(p);
      try { localStorage.setItem(storageKey, JSON.stringify(p)); } catch (e) { }
    }
  }, [pos, size, storageKey]);

  const down = (e) => {
    if (e.target.closest('button')) return;
    const el = root.current, host = hostOf();
    if (!el || !host) return;
    /* 헤더를 잡은 상대 위치를 유지하도록 픽셀 델타로 움직인다 */
    drag.current = {
      px: e.clientX, py: e.clientY,
      lx: el.offsetLeft, ly: el.offsetTop,
      hw: host.clientWidth, hh: host.clientHeight,
      w: el.offsetWidth, h: el.offsetHeight
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    const nx = Math.max(0, Math.min(d.hw - d.w, d.lx + (e.clientX - d.px)));
    const ny = Math.max(0, Math.min(d.hh - d.h, d.ly + (e.clientY - d.py)));
    const p = { x: nx / d.hw, y: ny / d.hh };
    setPos(p);
    try { localStorage.setItem(storageKey, JSON.stringify(p)); } catch (e2) { }
  };
  const up = () => { drag.current = null; };
  const style = pos
    ? { left: (pos.x * 100) + '%', top: (pos.y * 100) + '%', right: 'auto', bottom: 'auto' }
    : undefined;
  return (
    <div className={'pip pip-' + size} ref={root} style={style}>
      <div className="pip-h" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <span className="pip-t">{title}</span>
        <button onClick={onCycleSize} title="크기 전환">⤢</button>
      </div>
      <div className="pip-b">{children}</div>
    </div>
  );
}

/* ---------------- 미니맵 ---------------- */
function MiniMap() {
  const cache = VS.useRef(window.DroneRender.newMapCache());
  const draw = VS.useCallback((ctx, W, H) => {
    const d = window.DroneSim.state;
    window.DroneRender.renderMap(ctx, W, H, {
      cx: 0, cz: 0, ppm: Math.min(W, H) / 1050, cache: cache.current,
      drone: d, waypoints: d.waypoints, wpIdx: d.missionIdx, home: d.home,
      path: d.trail, showTrail: true, showGrid: false, showFence: true, fence: d.fence
    });
  }, []);
  const ref = window.useCanvas(draw, 15);
  return <canvas ref={ref} className="cv-fill" />;
}

Object.assign(window, { VR, PanelHead, ViewMap, View3D, ViewCam, Pip, MiniMap });
