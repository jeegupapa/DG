/* 3D 비행 재생 뷰 (MapLibre GL JS)
 * - 3D 지형(AWS Terrarium DEM) + OSM 지도 + 건물 돌출(OpenFreeMap 벡터)
 * - 경로를 비행 고도까지 세운 반투명 커튼, 고도에 떠 있는 드론 마커와 고도 기둥
 * - 시뮬레이션 결과의 구간별 시간·지상속도에 맞춰 실제 이동을 재생
 */
(() => {
  "use strict";

  const TERRAIN_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
  const OSM_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const OFM_TILEJSON = "https://tiles.openfreemap.org/planet";
  const STATUS_COLOR = { ok: "#1f74d8", warn: "#b8791a", fail: "#c0392b" };   // 구간 판정 톤 (커튼)
  const ACCENT = "#1f74d8", ACCENT_D = "#0f4c93", CRIT = "#c0392b";           // 드론·궤적은 강조색만

  // ─────────────────────── 지리 도우미
  const R = 6371008.8;
  const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
  function bearing(a, b) {
    const p1 = rad(a[0]), p2 = rad(b[0]), dl = rad(b[1] - a[1]);
    const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  function distance(a, b) {
    const p1 = rad(a[0]), p2 = rad(b[0]), dp = p2 - p1, dl = rad(b[1] - a[1]);
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  /** 기준점에서 동쪽 dx m, 북쪽 dy m 떨어진 [lon, lat] */
  function offset(lat, lon, dx, dy) {
    return [lon + dx / (111320 * Math.cos(rad(lat))), lat + dy / 110574];
  }
  /** 중심·방위·길이·폭의 직사각형 폴리곤 (GeoJSON ring) */
  function rect(lat, lon, headingDeg, length, width) {
    const h = rad(headingDeg), ux = Math.sin(h), uy = Math.cos(h);   // 진행 방향 단위벡터 (동, 북)
    const vx = uy, vy = -ux;                                          // 오른쪽
    const L = length / 2, W = width / 2;
    const c = [[L, W], [L, -W], [-L, -W], [-L, W], [L, W]];
    return [c.map(([a, b]) => offset(lat, lon, ux * a + vx * b, uy * a + vy * b))];
  }
  function fmtTime(s) { const m = Math.floor(s / 60), r = Math.floor(s % 60); return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`; }
  /** 점이 폴리곤 외곽 링 안에 있는지 (ray casting) */
  function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  // ─────────────────────── 비행 궤적
  class Track {
    constructor(result) {
      const segs = result.nominal.segments;
      this.usable = result.nominal.usable_wh || 1;
      this.keys = [];
      let e = 0;
      for (const s of segs) {
        if (!s.from_pos || !s.to_pos) continue;
        this.keys.push({ t0: s.start_s, t1: s.start_s + s.time_s, a: s.from_pos, b: s.to_pos, seg: s, e0: e, e1: e + s.energy_wh,
                         horiz: distance(s.from_pos, s.to_pos) > 0.5 });
        e += s.energy_wh;
      }
      this.total = this.keys.length ? this.keys[this.keys.length - 1].t1 : 0;
      this.home = this.keys.length ? this.keys[0].a : [0, 0, 0];
      this.maxAlt = Math.max(1, ...this.keys.map(k => Math.max(k.a[2], k.b[2])));
      this._heading = 0;
      // 고장 사건: 파이썬이 계산한 배터리 소진·제어 불능(비상 착륙) + 3D 검사·재생 중 감지한 충돌(추락)
      this.descentRate = (result.profile && result.profile.descent_rate_ms) || 2;
      this.failures = (result.nominal.failure_events || []).map(f => ({ ...f }));
      this.enabled = true;
    }
    addFailure(f) { this.failures.push(f); this.failures.sort((a, b) => a.t - b.t); }
    removeCollisions() { this.failures = this.failures.filter(f => f.kind !== "terrain" && f.kind !== "building"); }
    /** t 시점에 이미 발생한 가장 이른 고장 사건 (없으면 null) */
    activeFailure(t) {
      if (!this.enabled) return null;
      let best = null;
      for (const f of this.failures) if (f.t <= t && (!best || f.t < best.t)) best = f;
      return best;
    }
    firstFailure() { return this.activeFailure(Infinity); }
    /** 계획 경로상의 상태 (고장 무시) */
    baseAt(t) {
      t = Math.max(0, Math.min(t, this.total));
      let k = this.keys[this.keys.length - 1];
      for (const kk of this.keys) { if (t <= kk.t1) { k = kk; break; } }
      const dur = k.t1 - k.t0, f = dur > 0 ? Math.min(1, Math.max(0, (t - k.t0) / dur)) : 1;
      const lat = k.a[0] + (k.b[0] - k.a[0]) * f, lon = k.a[1] + (k.b[1] - k.a[1]) * f, alt = k.a[2] + (k.b[2] - k.a[2]) * f;
      if (k.horiz) this._heading = bearing(k.a, k.b);
      const vspeed = dur > 0 ? (k.b[2] - k.a[2]) / dur : 0;
      return {
        t, lat, lon, alt, heading: this._heading, seg: k.seg,
        groundSpeed: k.horiz ? (k.seg.ground_speed_ms || 0) : 0, vspeed,
        battery: (k.e0 + (k.e1 - k.e0) * f) / this.usable,
        done: t >= this.total, phase: "normal", failure: null,
      };
    }
    /** 고장을 반영한 상태: 추락은 자유낙하, 비상 착륙은 하강률로 제자리 하강. 지면(groundRel)에 닿으면 종료 */
    at(t) {
      const F = this.activeFailure(t);
      if (!F) return this.baseAt(t);
      const s0 = this.baseAt(F.t);
      const groundRel = typeof F.groundRel === "number" ? F.groundRel : 0;
      const dt = Math.max(0, t - F.t);
      const drop = F.mode === "crash" ? 0.5 * 9.81 * dt * dt : this.descentRate * dt;
      const alt = Math.max(groundRel, s0.alt - drop);
      const ended = alt <= groundRel + 1e-6;
      return { ...s0, t, alt, groundSpeed: 0, vspeed: ended ? 0 : -(F.mode === "crash" ? 9.81 * dt : this.descentRate),
               phase: ended ? "ended" : "emergency", failure: F, done: ended };
    }
    /** 재생이 끝나는 시각: 고장이 있으면 지면에 닿는 순간 */
    endTime() {
      const F = this.firstFailure();
      if (!F) return this.total;
      const s0 = this.baseAt(F.t);
      const h = Math.max(0, s0.alt - (typeof F.groundRel === "number" ? F.groundRel : 0));
      return F.t + (F.mode === "crash" ? Math.sqrt(2 * h / 9.81) : h / this.descentRate);
    }
    /** 지금까지 지나온 지면 궤적 좌표 (고장 시점 이후로는 늘어나지 않음) */
    trail(t) {
      const F = this.firstFailure();
      if (F && t > F.t) t = F.t;
      const pts = [];
      for (const k of this.keys) {
        if (!k.horiz) continue;
        if (k.t0 >= t) break;
        pts.push([k.a[1], k.a[0]]);
        const f = Math.min(1, (t - k.t0) / Math.max(1e-6, k.t1 - k.t0));
        pts.push([k.a[1] + (k.b[1] - k.a[1]) * f, k.a[0] + (k.b[0] - k.a[0]) * f]);
      }
      return pts;
    }
  }

  // ─────────────────────── 3D 뷰
  class Flight3D {
    constructor(container) {
      this.container = container;
      this.map = null; this.ready = false; this.track = null; this.result = null;
      this.t = 0; this.speed = 5; this.playing = false; this.follow = true; this.followZoom = 16.5;
      this._raf = null; this._last = null; this._homeElev = null; this._wpMarkers = [];
      this.onTick = null;   // (state) => void
      // 드론 시점(짐벌 카메라) PiP — 두 번째 MapLibre 맵. 자기 자신(드론 마커·커튼)은 그리지 않는다.
      this.cam = null; this.camReady = false; this.camEl = null; this.hudCanvas = null;
      this.camOn = true; this.camPaused = false; this.gimbalPitch = -30; this.camZoom = 1;
      this._camFov = null; this._camWpMarkers = []; this._camState = null;
      // 고장·충돌 시뮬레이션: 경로 사전 검사(지형·건물)와 재생 중 감지
      this.failSim = true; this.onScan = null;   // onScan({conflicts, buildings}) => void
      this._obstacleMarkers = []; this._crashMarker = null; this._scan = null; this._scanTries = 0;
      this._bCache = { t: 0, list: [] };
    }

    init() {
      if (this.map) return Promise.resolve();
      return new Promise(resolve => {
        // 기본 스타일은 OSM 래스터와 자체 GeoJSON 소스만 포함한다. 지형(DEM)과 건물(벡터)은
        // 선택 요소이므로 load 이후에 추가해, 해당 서버에 접속하지 못해도 재생은 되게 한다.
        const map = new maplibregl.Map({
          container: this.container,
          style: {
            version: 8,
            sources: {
              osm: { type: "raster", tiles: [OSM_TILES], tileSize: 256, maxzoom: 19, attribution: "© OpenStreetMap contributors · 지형: AWS Terrain Tiles · 건물: OpenFreeMap" },
              track: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
              trail: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
              curtain: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
              drone: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
              shadow: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
            },
            layers: [
              { id: "osm", type: "raster", source: "osm" },
              { id: "track", type: "line", source: "track", paint: { "line-color": ACCENT, "line-width": 2, "line-opacity": 0.5, "line-dasharray": [2, 2] } },
              { id: "trail", type: "line", source: "trail", paint: { "line-color": ACCENT, "line-width": 3.5 } },
              { id: "curtain", type: "fill-extrusion", source: "curtain",
                paint: { "fill-extrusion-color": ["get", "color"], "fill-extrusion-height": ["get", "h"], "fill-extrusion-base": ["get", "b"], "fill-extrusion-opacity": 0.32 } },
              { id: "shadow", type: "circle", source: "shadow", paint: { "circle-radius": 6, "circle-color": "#000", "circle-opacity": 0.35, "circle-blur": 0.6 } },
              { id: "drone", type: "fill-extrusion", source: "drone",
                paint: { "fill-extrusion-color": ["get", "color"], "fill-extrusion-height": ["get", "h"], "fill-extrusion-base": ["get", "b"], "fill-extrusion-opacity": 0.95 } },
            ],
          },
          center: [127.3845, 36.3504], zoom: 15, pitch: 60, bearing: 0, maxPitch: 82, antialias: true,
          attributionControl: { compact: true },
        });
        map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
        map.on("error", e => { const msg = e && e.error && e.error.message || ""; if (!/ofm|openfreemap|building/i.test(msg)) console.warn("maplibre:", msg); });
        let resolved = false;
        const finish = () => { if (resolved) return; resolved = true; this.ready = true; resolve(); };
        map.on("load", () => {
          // 지형: 실패해도 평면 지도로 계속 동작
          try {
            map.addSource("dem", { type: "raster-dem", tiles: [TERRAIN_TILES], encoding: "terrarium", tileSize: 256, maxzoom: 15 });
            map.addLayer({ id: "hillshade", type: "hillshade", source: "dem", paint: { "hillshade-exaggeration": 0.35 } }, "track");
            map.setTerrain({ source: "dem", exaggeration: 1.0 });
          } catch (e) { console.warn("terrain:", e); }
          // 건물 돌출: OpenFreeMap 벡터 타일 (없어도 무방)
          try {
            map.addSource("ofm", { type: "vector", url: OFM_TILEJSON });
            map.addLayer({ id: "buildings", type: "fill-extrusion", source: "ofm", "source-layer": "building", minzoom: 13,
              paint: { "fill-extrusion-color": "#d6dbe3", "fill-extrusion-height": ["coalesce", ["get", "render_height"], 8],
                       "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0], "fill-extrusion-opacity": 0.85 } }, "track");
          } catch (e) { console.warn("buildings:", e); }
          finish();
        });
        // 타일 서버 접속이 막혀 load 가 늦어져도 재생은 시작한다
        setTimeout(finish, 8000);
        map.on("dragstart", () => { this.follow = false; if (this.onFollowChange) this.onFollowChange(false); });
        this.map = map;
      });
    }

    resize() { if (this.map) this.map.resize(); this.resizeCam(); }

    // ─────────────────────── 짐벌 카메라 PiP
    /** PiP 본문(container)과 HUD 캔버스로 드론 시점 맵을 만든다. 저사양 대비: antialias 끔, 건물 minzoom 14. */
    initCam(container, hudCanvas) {
      if (this.cam) return Promise.resolve();
      this.camEl = container; this.hudCanvas = hudCanvas;
      return new Promise(resolve => {
        const cam = new maplibregl.Map({
          container,
          style: {
            version: 8,
            sources: {
              osm: { type: "raster", tiles: [OSM_TILES], tileSize: 256, maxzoom: 19 },
              track: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
              trail: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
            },
            layers: [
              { id: "osm", type: "raster", source: "osm" },
              { id: "track", type: "line", source: "track", paint: { "line-color": ACCENT, "line-width": 2, "line-opacity": 0.6, "line-dasharray": [2, 2] } },
              { id: "trail", type: "line", source: "trail", paint: { "line-color": ACCENT, "line-width": 3 } },
            ],
          },
          center: [127.3845, 36.3504], zoom: 16, pitch: 60, bearing: 0, maxPitch: 85,
          antialias: false, interactive: false, attributionControl: false,
          // 3D 뷰가 숨겨지면(display:none) MapLibre 의 자동 resize 가 0×0 으로 행렬을 계산하다 깨진다.
          // 자동 추적을 끄고 resizeCam() 에서 보일 때만 직접 resize 한다.
          trackResize: false,
        });
        cam.on("error", e => { const msg = e && e.error && e.error.message || ""; if (!/ofm|openfreemap|building/i.test(msg)) console.warn("maplibre(cam):", msg); });
        let resolved = false;
        const finish = () => { if (resolved) return; resolved = true; this.camReady = true; this._camLoad(); this.update(); resolve(); };
        cam.on("load", () => {
          try {
            cam.addSource("dem", { type: "raster-dem", tiles: [TERRAIN_TILES], encoding: "terrarium", tileSize: 256, maxzoom: 15 });
            cam.setTerrain({ source: "dem", exaggeration: 1.0 });
          } catch (e) { console.warn("terrain(cam):", e); }
          try {
            cam.addSource("ofm", { type: "vector", url: OFM_TILEJSON });
            cam.addLayer({ id: "buildings", type: "fill-extrusion", source: "ofm", "source-layer": "building", minzoom: 14,
              paint: { "fill-extrusion-color": "#d6dbe3", "fill-extrusion-height": ["coalesce", ["get", "render_height"], 8],
                       "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0], "fill-extrusion-opacity": 0.9 } }, "track");
          } catch (e) { console.warn("buildings(cam):", e); }
          finish();
        });
        setTimeout(finish, 8000);
        this.cam = cam;
      });
    }

    /** 결과가 바뀌면 PiP 맵에도 지면 궤적선과 웨이포인트 라벨을 올린다 */
    _camLoad() {
      if (!this.cam || !this.camReady || !this.track) return;
      const coords = this.track.keys.filter(k => k.horiz).flatMap(k => [[k.a[1], k.a[0]], [k.b[1], k.b[0]]]);
      this._setOn(this.cam, "track", coords.length ? [{ type: "Feature", geometry: { type: "LineString", coordinates: coords } }] : []);
      this._setOn(this.cam, "trail", []);
      this._camWpMarkers.forEach(m => m.remove()); this._camWpMarkers = [];
      (this.result.mission.waypoints || []).forEach((w, i) => {
        const el = document.createElement("div");
        el.className = "wp3d" + (i === 0 ? " home" : "");
        el.textContent = i === 0 ? "홈" : `WP${i + 1}`;
        this._camWpMarkers.push(new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([w.lon, w.lat]).addTo(this.cam));
      });
    }

    resizeCam() {
      if (!this.cam || !this.camOn || this.camPaused || !this.camEl) return;
      if (!(this.camEl.clientWidth > 0 && this.camEl.clientHeight > 0)) return;   // 숨김(0×0) 상태에서는 건드리지 않는다
      try { this.cam.resize(); } catch (e) { console.warn("cam resize:", e); }
      this._drawHud();
    }
    /** PiP 켜고 끄기 — 꺼져 있으면 카메라 갱신·렌더를 건너뛴다 */
    setCamOn(on) { this.camOn = !!on; if (this.camOn) { this.resizeCam(); this.update(); } }
    /** 2D 지도로 돌아가면 PiP 렌더를 멈추고, 3D 로 돌아오면 재개한다 */
    pauseCam() { this.camPaused = true; }
    resumeCam() { this.camPaused = false; this.resizeCam(); this.update(); }
    setGimbalPitch(deg) { this.gimbalPitch = Math.max(-90, Math.min(0, Number(deg) || 0)); this.update(); }
    setCamZoom(z) { this.camZoom = Math.max(1, Math.min(4, Number(z) || 1)); this.update(); }
    _camVisible() { return !!(this.cam && this.camReady && this.camOn && !this.camPaused && this.camEl && this.camEl.clientWidth > 0); }

    /** 매 프레임: 드론 위치(지형 절대고도 + 상대고도)에 카메라를 두고 방위·짐벌 피치로 바라본다 */
    _updateCam(st, agl, localElev, danger) {
      this._camState = { st, agl, danger };
      if (!this._camVisible()) return;                       // 숨겨져 있으면 카메라 호출 생략
      const cam = this.cam;
      const trail = this.track.trail(st.t);
      this._setOn(cam, "trail", trail.length >= 2 ? [{ type: "Feature", geometry: { type: "LineString", coordinates: trail } }] : []);
      // 카메라 고도: PiP 맵 자체 지형 고도를 우선 쓰고, 타일이 없으면 메인 맵 값으로 대신한다. 지면 아래로는 내려가지 않게 2 m 바닥.
      const camElev = this._elevOn(cam, st.lat, st.lon);
      const ground = camElev != null ? camElev : (localElev != null ? localElev : 0);
      const absAlt = ground + Math.max(2, agl);
      // 시야각(세로)은 줌으로 조절하되, "피치 + 시야각/2" 가 지평선(90°)을 넘으면 MapLibre 의 지형 투영 행렬 계산이
      // 실패해(jumpTo 예외) 카메라가 멈춘다. 화면 위쪽이 지평선 아래 약 6° 안쪽에 머물도록 둘을 함께 제한한다.
      const HORIZON_MARGIN = 84;
      const fov = Math.max(20, Math.min(60, 78 / this.camZoom));
      // 피치 0 = 수직 아래, 90 = 수평. 짐벌 -30° → 피치 60°.
      const pitch = Math.max(0, Math.min(HORIZON_MARGIN - fov / 2, 90 + this.gimbalPitch));
      if (this._camFov !== fov) { this._camFov = fov; cam.setVerticalFieldOfView(fov); }
      try {
        const o = cam.calculateCameraOptionsFromCameraLngLatAltRotation([st.lon, st.lat], absAlt, st.heading, pitch);
        // 돌려받은 객체(elevation·roll 등 포함)를 그대로 jumpTo 에 넘기면 지형이 켜진 맵에서 투영 행렬 계산이 깨져
        // 이후 모든 카메라 이동이 실패한다(WebView2 에서 재현). 필요한 값만 꺼내 단순 옵션으로 넘긴다.
        const c = o.center;
        const center = Array.isArray(c) ? c : [c.lng, c.lat];
        // 이륙·착륙 직후(지면 위 2 m)에 수직에 가깝게 내려다보면 줌이 극단적으로 커져 지형 렌더가 깨진다. 줌 20 으로 제한.
        const zoom = (!isFinite(o.zoom) || o.zoom > 20) ? 20 : o.zoom;
        cam.jumpTo({ center, zoom, bearing: st.heading, pitch });
        this._camErrors = 0;
      } catch (e) {
        // 실패한 프레임은 건너뛴다. 연속 실패하면 시야각을 다시 설정해 내부 행렬을 복구한다.
        this._camErrors = (this._camErrors || 0) + 1;
        if (this._camErrors % 10 === 0) {
          console.warn("cam jumpTo 실패, 시야각 재설정으로 복구 시도:", e && e.message);
          try { cam.setVerticalFieldOfView(36.87); cam.setVerticalFieldOfView(fov); } catch (_) { /* 무시 */ }
        }
      }
      this._drawHud();
    }

    /** 핸드오프 규격 카메라 HUD: 모서리 브래킷·레티클·피치 래더·판독값 */
    _drawHud() {
      const cv = this.hudCanvas, s = this._camState;
      if (!cv || !s || !this.camEl) return;
      const dpr = window.devicePixelRatio || 1;
      const W = this.camEl.clientWidth, H = this.camEl.clientHeight;
      if (!W || !H) return;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
      const ctx = cv.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const hud = "rgba(255,255,255,.92)";
      // 밝은 OSM 타일 위에서도 흰 HUD 가 읽히도록 선·글자에 옅은 어두운 테두리(그림자)를 준다
      ctx.shadowColor = "rgba(0,0,0,.55)"; ctx.shadowBlur = 2;
      // 모서리 브래킷: 22px 인셋, 26px 팔
      ctx.strokeStyle = hud; ctx.lineWidth = 1.6; ctx.lineCap = "butt";
      const m = 22, L = 26;
      for (const c of [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]]) {
        ctx.beginPath(); ctx.moveTo(c[0] + c[2] * L, c[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(c[0], c[1] + c[3] * L); ctx.stroke();
      }
      // 레티클: 5px 간격, 16px 팔, 3px 원. 지형 간격 5 m 미만이면 빨강
      ctx.strokeStyle = s.danger ? CRIT : "rgba(255,255,255,.95)"; ctx.lineWidth = s.danger ? 1.8 : 1.4;
      const cx = W / 2, cy = H / 2;
      ctx.beginPath();
      ctx.moveTo(cx - 16, cy); ctx.lineTo(cx - 5, cy); ctx.moveTo(cx + 5, cy); ctx.lineTo(cx + 16, cy);
      ctx.moveTo(cx, cy - 16); ctx.lineTo(cx, cy - 5); ctx.moveTo(cx, cy + 5); ctx.lineTo(cx, cy + 16);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.stroke();
      // 피치 래더: -30~+30°, 10° 간격. ppd = (H/2) / tan(fov/2) * DEG
      const fov = this._camFov || Math.max(20, Math.min(60, 78 / this.camZoom)), DEG = Math.PI / 180;   // 실제 적용된 시야각과 맞춘다
      const ppd = (H / 2) / Math.tan(fov * DEG / 2) * DEG;
      ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.lineWidth = 1;
      ctx.font = "600 9px 'IBM Plex Mono', Consolas, monospace"; ctx.fillStyle = "rgba(255,255,255,.75)"; ctx.textBaseline = "middle";
      for (let pd = -30; pd <= 30; pd += 10) {
        const yy = cy + (pd - this.gimbalPitch) * ppd;
        if (yy < 40 || yy > H - 40) continue;
        const wdt = pd === 0 ? 46 : 26;
        ctx.beginPath(); ctx.moveTo(cx - wdt, yy); ctx.lineTo(cx - 8, yy); ctx.moveTo(cx + 8, yy); ctx.lineTo(cx + wdt, yy); ctx.stroke();
        if (pd !== 0 && W >= 220) { ctx.textAlign = "left"; ctx.fillText((pd > 0 ? "+" : "") + pd, cx + wdt + 4, yy); }
      }
      // 판독값 (모노, 흰색 + 그림자)
      const st = s.st;
      ctx.font = "600 10px 'IBM Plex Mono', Consolas, monospace"; ctx.fillStyle = "#fff";
      ctx.shadowColor = "rgba(0,0,0,.6)"; ctx.shadowBlur = 3;
      ctx.textBaseline = "top"; ctx.textAlign = "left";
      ctx.fillText(`고도 ${st.alt.toFixed(0)} m · 지상속도 ${st.groundSpeed.toFixed(1)} m/s`, 8, 6);
      ctx.textAlign = "right";
      ctx.fillText(fmtTime(st.t), W - 8, 6);
      ctx.textBaseline = "bottom"; ctx.textAlign = "center";
      ctx.fillText(`방위 ${Math.round(st.heading)}° · 짐벌 ${Math.round(this.gimbalPitch)}°`, cx, H - 6);
      if (s.danger) { ctx.fillStyle = CRIT; ctx.font = "700 10px 'IBM Plex Sans KR', 'Malgun Gothic', sans-serif"; ctx.fillText("⚠ 지형 간격 5 m 미만", cx, H - 20); }
      ctx.shadowBlur = 0;
    }

    load(result) {
      this.result = result;
      this.track = new Track(result);
      this.t = 0; this.playing = false; this._last = null; this._homeElev = null;
      const home = this.track.home;
      const wps = result.mission.waypoints;

      // 지면 궤적
      const coords = this.track.keys.filter(k => k.horiz).flatMap(k => [[k.a[1], k.a[0]], [k.b[1], k.b[0]]]);
      this._set("track", coords.length ? [{ type: "Feature", geometry: { type: "LineString", coordinates: coords } }] : []);
      this._set("trail", []);

      // 커튼: 구간을 50 m 조각으로 나눠 폭 2.5 m 벽을 세운다
      const feats = [];
      for (const k of this.track.keys) {
        if (!k.horiz) continue;
        const d = distance(k.a, k.b), n = Math.max(1, Math.ceil(d / 50)), hd = bearing(k.a, k.b);
        for (let i = 0; i < n; i++) {
          const f0 = i / n, f1 = (i + 1) / n, fm = (f0 + f1) / 2;
          const lat = k.a[0] + (k.b[0] - k.a[0]) * fm, lon = k.a[1] + (k.b[1] - k.a[1]) * fm;
          const alt = k.a[2] + (k.b[2] - k.a[2]) * fm;
          feats.push({ type: "Feature", properties: { color: STATUS_COLOR[k.seg.status] || STATUS_COLOR.ok, h: alt, b: 0 },
                       geometry: { type: "Polygon", coordinates: rect(lat, lon, hd, d / n + 0.3, 2.5) } });
        }
      }
      this._set("curtain", feats);

      // 웨이포인트 라벨
      this._wpMarkers.forEach(m => m.remove()); this._wpMarkers = [];
      wps.forEach((w, i) => {
        const el = document.createElement("div");
        el.className = "wp3d" + (i === 0 ? " home" : "");
        el.textContent = i === 0 ? "홈" : `WP${i + 1}`;
        this._wpMarkers.push(new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([w.lon, w.lat]).addTo(this.map));
      });

      // 카메라: 경로 전체가 보이도록
      const b = new maplibregl.LngLatBounds();
      wps.forEach(w => b.extend([w.lon, w.lat]));
      if (wps.length === 1) b.extend(offset(home[0], home[1], 150, 150)).extend(offset(home[0], home[1], -150, -150));
      this.map.fitBounds(b, { padding: 80, pitch: 55, bearing: 0, duration: 0, maxZoom: 17 });
      this._camLoad();
      // 고장·충돌: 이전 결과의 마커를 지우고, 지형·건물 타일이 로드된 뒤(idle) 경로를 검사한다
      this.track.enabled = this.failSim;
      this._clearObstacleMarkers();
      this._scan = null; this._scanTries = 0;
      this._scheduleScan(400);
      this.update();
    }
    /** 추적 카메라가 움직이는 동안 지도는 idle 이 되지 않으므로, 이벤트 대신 주기적으로 타일 로드를 확인해 검사한다 */
    _scheduleScan(delay) {
      if (this._scanTimer) clearTimeout(this._scanTimer);
      const token = this.track;
      this._scanTimer = setTimeout(() => {
        this._scanTimer = null;
        if (!this.map || this.track !== token) return;          // 그 사이 다른 결과가 로드됨
        this._runScan();
      }, delay);
    }

    // ─────────────────────── 장애물 검사 (지형·건물)
    _clearObstacleMarkers() {
      this._obstacleMarkers.forEach(m => m.remove()); this._obstacleMarkers = [];
      if (this._crashMarker) { this._crashMarker.remove(); this._crashMarker = null; }
    }
    /** 현재 로드된 건물 폴리곤(외곽 링·bbox·높이). 2초 캐시 */
    _loadedBuildings(force) {
      const now = performance.now();
      if (!force && now - this._bCache.t < 2000) return this._bCache.list;
      const out = [];
      try {
        if (this.map.getSource("ofm")) {
          for (const f of this.map.querySourceFeatures("ofm", { sourceLayer: "building" })) {
            const p = f.properties || {};
            const h = Number(p.render_height != null ? p.render_height : p.height) || 8;
            const g = f.geometry; if (!g) continue;
            const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
            for (const rings of polys) {
              const ring = rings[0]; if (!ring || ring.length < 3) continue;
              let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
              for (const [x, y] of ring) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
              out.push({ ring, bbox: [x0, y0, x1, y1], height: h });
            }
          }
        }
      } catch (_) { /* 건물 소스가 없거나 아직 로드 전 */ }
      this._bCache = { t: now, list: out };
      return out;
    }
    _tallestBuildingAt(buildings, lat, lon) {
      let best = null;
      for (const b of buildings) {
        const [x0, y0, x1, y1] = b.bbox;
        if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
        if (pointInRing(lon, lat, b.ring) && (!best || b.height > best.height)) best = b;
      }
      return best;
    }
    _runScan() {
      if (!this.track || !this.ready) return;
      const tries = this._scanTries++;
      let tilesReady = true;
      try { tilesReady = this.map.areTilesLoaded(); } catch (_) { /* 무시 */ }
      // 지형·건물 타일이 아직 로드 중이면 잠시 뒤 다시 (최대 20초), 그 뒤에는 있는 자료로 검사
      if (!tilesReady && tries < 20) { this._scheduleScan(1000); return; }
      const res = this.scanObstacles();
      if (!res) { if (tries < 20) this._scheduleScan(1000); return; }          // 출발지 지형 고도 미확정
      // 건물 소스가 있는데 아직 한 건도 로드되지 않았으면 5초 뒤 한 번 더 검사해 늦게 온 타일을 반영
      if (res.buildings === 0 && this.map.getSource("ofm") && tries < 20) this._scheduleScan(5000);
    }
    /** 경로를 10 m 간격으로 훑어 지형·건물 충돌(불가)과 10 m 미만 근접(주의)을 찾는다. 첫 충돌은 추락 사건으로 등록 */
    scanObstacles() {
      const homeElev = this._elev(this.track.home[0], this.track.home[1]);
      if (homeElev == null || homeElev === 0) return null;
      this._homeElev = homeElev;
      const buildings = this._loadedBuildings(true);
      const STEP = 10, conflicts = [];
      let cur = null;
      for (const k of this.track.keys) {
        if (!k.horiz) { cur = null; continue; }
        const d = distance(k.a, k.b), n = Math.max(1, Math.ceil(d / STEP));
        for (let i = 0; i <= n; i++) {
          const f = i / n;
          const lat = k.a[0] + (k.b[0] - k.a[0]) * f, lon = k.a[1] + (k.b[1] - k.a[1]) * f, alt = k.a[2] + (k.b[2] - k.a[2]) * f;
          const t = k.t0 + (k.t1 - k.t0) * f;
          const elev = this._elev(lat, lon);
          if (elev == null) { cur = null; continue; }
          const absAlt = homeElev + alt, agl = absAlt - elev;
          let hit = null;
          if (agl <= 0.5) hit = { kind: "terrain", level: "fail", label: "지형 충돌", detail: `지면보다 ${Math.max(0, -agl).toFixed(0)} m 아래`, clearance: agl };
          else {
            const b = this._tallestBuildingAt(buildings, lat, lon);
            if (b) {
              const clr = absAlt - (elev + b.height);
              if (clr <= 0) hit = { kind: "building", level: "fail", label: "건물 충돌", detail: `건물 높이 ${b.height.toFixed(0)} m, 비행 고도보다 ${(-clr).toFixed(0)} m 높음`, clearance: clr };
              else if (clr < 10) hit = { kind: "building", level: "warn", label: "건물 근접", detail: `건물 위 ${clr.toFixed(0)} m`, clearance: clr };
            }
            if (!hit && agl < 10) hit = { kind: "terrain", level: "warn", label: "지형 근접", detail: `지면 위 ${agl.toFixed(0)} m`, clearance: agl };
          }
          if (!hit) { cur = null; continue; }
          if (cur && cur.kind === hit.kind && cur.level === hit.level) {
            if (hit.clearance < cur.clearance) Object.assign(cur, { detail: hit.detail, clearance: hit.clearance });
            cur.tEnd = t;
          } else {
            cur = { ...hit, t, tEnd: t, lat, lon, alt, elev, segLabel: k.seg.label };
            conflicts.push(cur);
          }
        }
      }
      // 첫 충돌 지점을 추락 사건으로 등록 (이전 검사 결과는 교체)
      this.track.removeCollisions();
      const first = conflicts.find(c => c.level === "fail");
      if (first) this.track.addFailure({ kind: first.kind, mode: "crash", t: first.t, lat: first.lat, lon: first.lon, alt: first.alt,
                                         label: first.label, detail: first.detail, groundRel: first.elev - homeElev });
      // 마커
      this._obstacleMarkers.forEach(m => m.remove()); this._obstacleMarkers = [];
      for (const c of conflicts) {
        const el = document.createElement("div");
        el.className = "obs3d " + c.level;
        el.textContent = (c.level === "fail" ? "✕ " : "⚠ ") + c.label;
        el.title = `${c.segLabel} · ${c.detail}`;
        this._obstacleMarkers.push(new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([c.lon, c.lat]).addTo(this.map));
      }
      this._scan = { conflicts, buildings: buildings.length, homeElev };
      if (this.onScan) this.onScan(this._scan);
      return this._scan;
    }
    setFailSim(on) {
      this.failSim = !!on;
      if (this.track) this.track.enabled = this.failSim;
      if (!this.failSim && this._crashMarker) { this._crashMarker.remove(); this._crashMarker = null; }
      this.update();
    }

    _set(id, features) { this._setOn(this.map, id, features); }
    _setOn(map, id, features) { const s = map && map.getSource(id); if (s) s.setData({ type: "FeatureCollection", features }); }

    /** 지형 절대 고도(m). queryTerrainElevation 은 화면 중심 대비 상대값이라 쓰지 않는다. 타일 미로딩 시 null. */
    _elev(lat, lon) { return this._elevOn(this.map, lat, lon); }
    _elevOn(map, lat, lon) {
      try {
        const terrain = map.terrain;
        if (!terrain) return null;
        const z = Math.max(10, Math.min(14, Math.floor(map.getZoom())));
        const e = terrain.getElevationForLngLatZoom(new maplibregl.LngLat(lon, lat), z);
        return (typeof e === "number" && isFinite(e)) ? e : null;
      } catch (_) { return null; }
    }

    _end() { return this.track ? Math.max(this.track.total, this.track.endTime()) : 0; }
    play() {
      if (!this.track) return;
      if (this.t >= this.track.endTime() - 1e-6) { this.t = 0; if (this._crashMarker) { this._crashMarker.remove(); this._crashMarker = null; } }
      this.playing = true; this._last = null;
      if (!this._raf) this._raf = requestAnimationFrame(ts => this._frame(ts));
    }
    pause() { this.playing = false; }
    toggle() { this.playing ? this.pause() : this.play(); }
    seek(t) { this.t = Math.max(0, Math.min(t, this._end())); if (this._crashMarker && this.t < this.track.endTime()) { this._crashMarker.remove(); this._crashMarker = null; } this.update(); }
    setFollow(on) { this.follow = on; if (on) this.update(); }

    _frame(ts) {
      this._raf = null;
      if (!this.playing) return;
      if (this._last != null) this.t += (ts - this._last) / 1000 * this.speed;
      this._last = ts;
      const end = this.track.endTime();
      if (this.t >= end) { this.t = end; this.playing = false; }
      this.update();
      if (this.playing) this._raf = requestAnimationFrame(t2 => this._frame(t2));
    }

    update() {
      if (!this.track || !this.ready) return;
      const zoom = this.map.getZoom();
      const size = Math.max(2.5, 70 / Math.pow(2, zoom - 13));            // 화면에서 보이는 크기로 보정
      // 출발지 지형 고도는 타일이 늦게 로드될 수 있어 유효값이 나올 때까지 매 프레임 다시 읽는다
      const he = this._elev(this.track.home[0], this.track.home[1]);
      if (he != null && he !== 0) this._homeElev = he;
      const homeElev = this._homeElev;
      // 파이썬이 계산한 고장 사건(배터리·제어)은 지면 상대고도를 모르므로 처음 활성화될 때 지형에서 읽어 둔다
      const F0 = this.track.activeFailure(this.t);
      if (F0 && typeof F0.groundRel !== "number" && homeElev != null) { const e0 = this._elev(F0.lat, F0.lon); if (e0 != null) F0.groundRel = e0 - homeElev; }
      let st = this.track.at(this.t);
      let localElev = homeElev == null ? null : this._elev(st.lat, st.lon);
      let agl = localElev != null && homeElev != null ? st.alt + homeElev - localElev : st.alt;
      // 재생 중 충돌 감지(사전 검사에서 놓친 경우의 보조): 지면 아래로 내려가거나 건물 안으로 들어가면 그 자리에서 추락
      if (this.failSim && st.phase === "normal" && st.t > 0 && localElev != null && st.seg.kind !== "takeoff" && st.seg.kind !== "land") {
        let hit = null;
        if (agl <= 0.3) hit = { kind: "terrain", label: "지형 충돌", detail: "비행 고도가 지면보다 낮음" };
        else {
          const b = this._tallestBuildingAt(this._loadedBuildings(false), st.lat, st.lon);
          if (b && homeElev + st.alt < localElev + b.height) hit = { kind: "building", label: "건물 충돌", detail: `건물 높이 ${b.height.toFixed(0)} m` };
        }
        if (hit) {
          this.track.addFailure({ ...hit, mode: "crash", t: st.t, lat: st.lat, lon: st.lon, alt: st.alt, groundRel: localElev - homeElev });
          st = this.track.at(this.t);
        }
      }
      // 고도는 출발지 기준 상대고도. 지형 위에 그려지므로 지형 높이 차이를 보정한다.
      const corr = (homeElev != null && localElev != null) ? homeElev - localElev : 0;
      const base = Math.max(0, st.alt + corr);
      agl = localElev != null && homeElev != null ? st.alt + homeElev - localElev : st.alt;
      const danger = st.phase === "normal" && agl < 5 && st.seg.kind !== "takeoff" && st.seg.kind !== "land" && st.t > 0;
      const F = st.failure;
      const color = F ? (F.mode === "crash" ? CRIT : STATUS_COLOR.warn) : (danger ? CRIT : ACCENT);
      // 추락·비상 착륙이 끝나면 그 자리에 표식을 남긴다
      if (F && st.phase === "ended" && !this._crashMarker) {
        const el = document.createElement("div");
        el.className = "crash3d " + (F.mode === "crash" ? "fail" : "warn");
        el.textContent = (F.mode === "crash" ? "✕ 추락 · " : "비상 착륙 · ") + F.label;
        this._crashMarker = new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([st.lon, st.lat]).addTo(this.map);
      }

      const arms = [
        { type: "Feature", properties: { color, h: base + size * 0.25, b: base }, geometry: { type: "Polygon", coordinates: rect(st.lat, st.lon, st.heading + 45, size * 1.6, size * 0.28) } },
        { type: "Feature", properties: { color, h: base + size * 0.25, b: base }, geometry: { type: "Polygon", coordinates: rect(st.lat, st.lon, st.heading - 45, size * 1.6, size * 0.28) } },
        { type: "Feature", properties: { color: ACCENT_D, h: base + size * 0.45, b: base }, geometry: { type: "Polygon", coordinates: rect(st.lat, st.lon, st.heading, size * 0.9, size * 0.45) } },
        { type: "Feature", properties: { color: "#ffffff", h: base + size * 0.5, b: base + size * 0.45 }, geometry: { type: "Polygon", coordinates: rect(st.lat, st.lon, st.heading, size * 0.5, size * 0.3) } },
        // 고도 기둥 (드론 아래 지면까지)
        { type: "Feature", properties: { color: ACCENT, h: base, b: 0 }, geometry: { type: "Polygon", coordinates: rect(st.lat, st.lon, 0, size * 0.12, size * 0.12) } },
      ];
      this._set("drone", arms);
      this._set("shadow", [{ type: "Feature", geometry: { type: "Point", coordinates: [st.lon, st.lat] } }]);
      const trail = this.track.trail(st.t);
      this._set("trail", trail.length >= 2 ? [{ type: "Feature", geometry: { type: "LineString", coordinates: trail } }] : []);

      if (this.follow) {
        this.map.jumpTo({ center: [st.lon, st.lat], bearing: st.heading, pitch: 62, zoom: this.followZoom });
      }
      this._updateCam(st, agl, localElev, danger);     // 추적 카메라와 무관하게 PiP 는 항상 드론 시점
      if (this.onTick) this.onTick({ ...st, agl, danger, total: this.track.total, endTime: this.track.endTime(), localElev, homeElev });
    }

    destroy() {
      this.pause();
      this._clearObstacleMarkers();
      if (this.cam) { this.cam.remove(); this.cam = null; this.camReady = false; }
      if (this.map) { this.map.remove(); this.map = null; this.ready = false; }
    }
  }

  window.Flight3D = Flight3D;
  window.Flight3D.fmtTime = fmtTime;
})();
