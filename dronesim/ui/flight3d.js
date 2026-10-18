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
    }
    at(t) {
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
        done: t >= this.total,
      };
    }
    /** 지금까지 지나온 지면 궤적 좌표 */
    trail(t) {
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

    resize() { if (this.map) this.map.resize(); }

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
      this.update();
    }

    _set(id, features) { const s = this.map.getSource(id); if (s) s.setData({ type: "FeatureCollection", features }); }

    /** 지형 절대 고도(m). queryTerrainElevation 은 화면 중심 대비 상대값이라 쓰지 않는다. 타일 미로딩 시 null. */
    _elev(lat, lon) {
      try {
        const terrain = this.map.terrain;
        if (!terrain) return null;
        const z = Math.max(10, Math.min(14, Math.floor(this.map.getZoom())));
        const e = terrain.getElevationForLngLatZoom(new maplibregl.LngLat(lon, lat), z);
        return (typeof e === "number" && isFinite(e)) ? e : null;
      } catch (_) { return null; }
    }

    play() { if (!this.track) return; if (this.t >= this.track.total) this.t = 0; this.playing = true; this._last = null; if (!this._raf) this._raf = requestAnimationFrame(ts => this._frame(ts)); }
    pause() { this.playing = false; }
    toggle() { this.playing ? this.pause() : this.play(); }
    seek(t) { this.t = Math.max(0, Math.min(t, this.track ? this.track.total : 0)); this.update(); }
    setFollow(on) { this.follow = on; if (on) this.update(); }

    _frame(ts) {
      this._raf = null;
      if (!this.playing) return;
      if (this._last != null) this.t += (ts - this._last) / 1000 * this.speed;
      this._last = ts;
      if (this.t >= this.track.total) { this.t = this.track.total; this.playing = false; }
      this.update();
      if (this.playing) this._raf = requestAnimationFrame(t2 => this._frame(t2));
    }

    update() {
      if (!this.track || !this.ready) return;
      const st = this.track.at(this.t);
      const zoom = this.map.getZoom();
      const size = Math.max(2.5, 70 / Math.pow(2, zoom - 13));            // 화면에서 보이는 크기로 보정
      // 출발지 지형 고도는 타일이 늦게 로드될 수 있어 유효값이 나올 때까지 매 프레임 다시 읽는다
      const he = this._elev(this.track.home[0], this.track.home[1]);
      if (he != null && he !== 0) this._homeElev = he;
      const homeElev = this._homeElev;
      const localElev = homeElev == null ? null : this._elev(st.lat, st.lon);
      // 고도는 출발지 기준 상대고도. 지형 위에 그려지므로 지형 높이 차이를 보정한다.
      const corr = (homeElev != null && localElev != null) ? homeElev - localElev : 0;
      const base = Math.max(0, st.alt + corr);
      const agl = localElev != null && homeElev != null ? st.alt + homeElev - localElev : st.alt;
      const danger = agl < 5 && st.seg.kind !== "takeoff" && st.seg.kind !== "land" && st.t > 0;
      const color = danger ? CRIT : ACCENT;

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
      if (this.onTick) this.onTick({ ...st, agl, danger, total: this.track.total, localElev, homeElev });
    }

    destroy() { this.pause(); if (this.map) { this.map.remove(); this.map = null; this.ready = false; } }
  }

  window.Flight3D = Flight3D;
  window.Flight3D.fmtTime = fmtTime;
})();
