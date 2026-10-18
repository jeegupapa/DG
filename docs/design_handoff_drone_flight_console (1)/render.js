/* ==========================================================================
   DroneRender — 2D 지도 / 3D 지형 / 짐벌 카메라 뷰 렌더러
   window.DroneRender.{ renderMap, renderScene, renderCam }
   ========================================================================== */
(function () {
  var DEG = Math.PI / 180;
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var TH = function (x, z) { return window.DroneSim.terrainH(x, z); };
  var WATER = -7.2;

  var ACCENT = '#1f74d8';
  var ACCENT_D = '#0f4c93';

  /* ---- 색상 램프 ------------------------------------------------------ */
  var BANDS = [
    [146, 19, 90.0], [126, 17, 91.8], [ 98, 15, 92.4],
    [ 70, 19, 92.8], [ 46, 23, 93.2], [ 32, 21, 91.0]
  ];
  function landHSL(h, shade, contrast) {
    var bi = clamp(Math.floor((h + 20) / 6.8), 0, 5);
    var c = BANDS[bi];
    var f = 1 + contrast * shade;
    var L = clamp(c[2] * f, 62, 99);
    return 'hsl(' + c[0] + ' ' + c[1] + '% ' + L.toFixed(1) + '%)';
  }
  function waterHSL(h) {
    var t = clamp((WATER - h) / 9, 0, 1);
    var L = 92 - t * 13, S2 = 40 + t * 18;
    return 'hsl(203 ' + S2.toFixed(0) + '% ' + L.toFixed(1) + '%)';
  }

  /* ---- 3D 투영 -------------------------------------------------------- */
  function makeCam(pos, target, fov, W, H, roll) {
    var f = (H / 2) / Math.tan(fov * DEG / 2);
    var fx = target[0] - pos[0], fy = target[1] - pos[1], fz = target[2] - pos[2];
    var fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
    var ux = 0, uy = 1, uz = 0;
    var rx = fy * uz - fz * uy, ry = fz * ux - fx * uz, rz = fx * uy - fy * ux;
    var rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
    var ux2 = ry * fz - rz * fy, uy2 = rz * fx - rx * fz, uz2 = rx * fy - ry * fx;
    if (roll) {
      var c = Math.cos(roll * DEG), s = Math.sin(roll * DEG);
      var nrx = rx * c + ux2 * s, nry = ry * c + uy2 * s, nrz = rz * c + uz2 * s;
      var nux = -rx * s + ux2 * c, nuy = -ry * s + uy2 * c, nuz = -rz * s + uz2 * c;
      rx = nrx; ry = nry; rz = nrz; ux2 = nux; uy2 = nuy; uz2 = nuz;
    }
    return { p: pos, f: [fx, fy, fz], r: [rx, ry, rz], u: [ux2, uy2, uz2], fl: f, cx: W / 2, cy: H / 2 };
  }
  function proj(c, x, y, z) {
    var dx = x - c.p[0], dy = y - c.p[1], dz = z - c.p[2];
    var vz = dx * c.f[0] + dy * c.f[1] + dz * c.f[2];
    if (vz < 0.6) return null;
    var vx = dx * c.r[0] + dy * c.r[1] + dz * c.r[2];
    var vy = dx * c.u[0] + dy * c.u[1] + dz * c.u[2];
    return { x: c.cx + vx / vz * c.fl, y: c.cy - vy / vz * c.fl, z: vz };
  }
  function projFlat(c, x, y, z) {
    var dx = x - c.p[0], dy = y - c.p[1], dz = z - c.p[2];
    var vz = dx * c.f[0] + dy * c.f[1] + dz * c.f[2];
    if (vz < 0.6) return null;
    var vx = dx * c.r[0] + dy * c.r[1] + dz * c.r[2];
    var vy = dx * c.u[0] + dy * c.u[1] + dz * c.u[2];
    return { x: c.cx + vx / vz * c.fl, y: c.cy - vy / vz * c.fl, z: vz };
  }

  function chip(ctx, x, y, text, fg, bg, size) {
    size = size || 10.5;
    ctx.font = '600 ' + size + 'px "IBM Plex Mono", ui-monospace, monospace';
    var w = ctx.measureText(text).width + 12, h = size + 9;
    ctx.fillStyle = bg || 'rgba(255,255,255,.86)';
    ctx.strokeStyle = 'rgba(40,60,80,.16)'; ctx.lineWidth = 1;
    rrect(ctx, x, y - h / 2, w, h, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = fg || '#22303f';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 6, y + 0.5);
    return w;
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

  /* ---- 지형 (3D) ------------------------------------------------------ */
  function drawTerrain3D(ctx, cam, o) {
    var step = o.step || 30, half = o.extent || 540;
    /* 쿼드 수 상한 — 작은 캔버스에 수천 개를 그리면 프레임이 무너진다.
       셀 크기를 키워서 총 쿼드 수를 예산 안으로 묶는다. */
    var maxQ = o.maxQuads || 620;
    step = Math.max(step, (half * 2) / Math.sqrt(maxQ));
    var fx = o.focus[0], fz = o.focus[1];
    var i0 = Math.floor((fx - half) / step), i1 = Math.ceil((fx + half) / step);
    var j0 = Math.floor((fz - half) / step), j1 = Math.ceil((fz + half) / step);
    var nx = i1 - i0, nz = j1 - j0;
    if (nx > 60 || nz > 60) return;
    var H = [], P = [];
    for (var i = 0; i <= nx; i++) {
      H[i] = []; P[i] = [];
      for (var j = 0; j <= nz; j++) {
        var wx = (i0 + i) * step, wz = (j0 + j) * step;
        H[i][j] = TH(wx, wz);
        P[i][j] = proj(cam, wx, H[i][j], wz);
      }
    }
    var list = [];
    /* 안개: 원거리 쿼드를 하늘색으로 수렴시켜 지형 경계의 칼끝선을 없앤다 */
    var fogA = half * 0.55, fogB = half * 1.02;
    for (var a = 0; a < nx; a++) for (var b = 0; b < nz; b++) {
      var p00 = P[a][b], p10 = P[a + 1][b], p11 = P[a + 1][b + 1], p01 = P[a][b + 1];
      if (!p00 || !p10 || !p11 || !p01) continue;
      var x0 = (i0 + a) * step, z0 = (j0 + b) * step;
      var h00 = H[a][b], h10 = H[a + 1][b], h11 = H[a + 1][b + 1], h01 = H[a][b + 1];
      var havg = (h00 + h10 + h11 + h01) / 4;
      var bi0 = Math.floor((h00 + h11) / 8.4), bi1 = Math.floor((h10 + h01) / 8.4);
      var gx = ((h10 + h11) - (h00 + h01)) / (2 * step);
      var gz = ((h01 + h11) - (h00 + h10)) / (2 * step);
      var shade = clamp(-(gx * -0.62 + gz * -0.78) * 2.4, -1, 1);
      var cxw = x0 + step / 2, czw = z0 + step / 2;
      var depth = (cxw - cam.p[0]) * cam.f[0] + (havg - cam.p[1]) * cam.f[1] + (czw - cam.p[2]) * cam.f[2];
      list.push({ p: [p00, p10, p11, p01], h: havg, shade: shade, d: depth, band: (bi0 !== bi1), fog: clamp((depth - fogA) / (fogB - fogA), 0, 1) });
    }
    list.sort(function (A, B) { return B.d - A.d; });
    window.__quads = list.length;
    ctx.lineWidth = 1;
    for (var k = 0; k < list.length; k++) {
      var it = list[k], ps = it.p;
      var isW = it.h < WATER;
      ctx.fillStyle = isW ? waterHSL(it.h) : landHSL(it.h, it.shade, 0.085);
      ctx.globalAlpha = 1 - it.fog * 0.92;
      ctx.beginPath();
      ctx.moveTo(ps[0].x, ps[0].y);
      ctx.lineTo(ps[1].x, ps[1].y);
      ctx.lineTo(ps[2].x, ps[2].y);
      ctx.lineTo(ps[3].x, ps[3].y);
      ctx.closePath();
      ctx.fill();
      /* 경계선은 물가와 등고 밴드 경계에만 그린다(전 셀 외곽선은 비용이 크다) */
      if ((isW || it.band) && it.fog < 0.5) {
        ctx.strokeStyle = isW ? 'rgba(120,160,190,.35)' : 'rgba(64,86,74,.10)';
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    return list;
  }

  /* ---- 공통 씬 -------------------------------------------------------- */
  function sky(ctx, W, H) {
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, 'hsl(207 62% 90%)');
    g.addColorStop(0.42, 'hsl(203 50% 95.5%)');
    g.addColorStop(0.72, 'hsl(45 28% 97%)');
    g.addColorStop(1, 'hsl(38 22% 96%)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  function drawPath3D(ctx, cam, path, color, width, dim) {
    if (path.length < 2) return;
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.globalAlpha = dim || 1;
    ctx.beginPath();
    var pen = false;
    for (var i = 0; i < path.length; i++) {
      var p = proj(cam, path[i].x, path[i].alt, path[i].z);
      if (!p) { pen = false; continue; }
      if (!pen) { ctx.moveTo(p.x, p.y); pen = true; } else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawDrone3D(ctx, cam, d, scale) {
    scale = scale || 7;
    var y = d.groundY + d.alt;
    var yaw = d.yaw * DEG;
    var c = Math.cos(yaw), s = Math.sin(yaw);
    var pts = [];
    var arms = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
    for (var i = 0; i < 4; i++) {
      var lx = arms[i][0] * scale, lz = arms[i][1] * scale;
      var wx = d.x + lx * c - lz * s;
      var wz = d.z + lx * s + lz * c;
      pts.push(proj(cam, wx, y, wz));
    }
    var ctr = proj(cam, d.x, y, d.z);
    var nose = proj(cam, d.x + Math.sin(yaw) * scale * 1.5, y, d.z - Math.cos(yaw) * scale * 1.5);
    if (!ctr) return;
    // 그림자
    var sh = proj(cam, d.x, d.groundY + 0.2, d.z);
    if (sh) {
      var sr = Math.max(3, Math.min(26, 900 / sh.z));
      ctx.fillStyle = 'rgba(40,60,50,.20)';
      ctx.beginPath(); ctx.ellipse(sh.x, sh.y, sr * 1.5, sr * 0.62, 0, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(31,116,216,.45)'; ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(sh.x, sh.y); ctx.lineTo(ctr.x, ctr.y); ctx.stroke();
      ctx.setLineDash([]);
    }
    for (var k = 0; k < 4; k++) {
      var p = pts[k];
      if (!p) continue;
      ctx.strokeStyle = 'rgba(24,40,58,.85)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(ctr.x, ctr.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      var rr = Math.max(2.5, Math.min(11, 420 / p.z));
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.beginPath(); ctx.ellipse(p.x, p.y, rr, rr * 0.5, 0, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(24,40,58,.75)'; ctx.lineWidth = 1.2; ctx.stroke();
    }
    var br = Math.max(3, Math.min(9, 360 / ctr.z));
    ctx.fillStyle = ACCENT_D;
    ctx.beginPath(); ctx.ellipse(ctr.x, ctr.y, br, br * 0.72, 0, 0, 7); ctx.fill();
    if (nose) {
      ctx.strokeStyle = ACCENT; ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.moveTo(ctr.x, ctr.y); ctx.lineTo(nose.x, nose.y); ctx.stroke();
    }
    chip(ctx, ctr.x + 14, ctr.y - 16, 'AGL ' + d.alt.toFixed(1) + ' m', '#0f4c93', 'rgba(255,255,255,.9)', 10.5);
  }

  function drawMarkers3D(ctx, cam, wps, idx, home, d) {
    // 임무 회랑
    if (wps.length > 1) {
      ctx.setLineDash([5, 6]); ctx.strokeStyle = 'rgba(31,116,216,.5)'; ctx.lineWidth = 1.4;
      ctx.beginPath(); var pen = false;
      for (var i = 0; i < wps.length; i++) {
        var p = proj(cam, wps[i].x, wps[i].alt, wps[i].z);
        if (!p) { pen = false; continue; }
        if (!pen) { ctx.moveTo(p.x, p.y); pen = true; } else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke(); ctx.setLineDash([]);
    }
    for (var k = 0; k < wps.length; k++) {
      var w = wps[k];
      var gy = TH(w.x, w.z);
      var top = proj(cam, w.x, w.alt, w.z), bot = proj(cam, w.x, gy, w.z);
      if (!top) continue;
      var active = k === idx;
      if (bot) {
        ctx.strokeStyle = active ? 'rgba(31,116,216,.85)' : 'rgba(70,90,110,.42)';
        ctx.lineWidth = active ? 1.8 : 1.2;
        ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(bot.x, bot.y); ctx.stroke();
      }
      var r = Math.max(3.5, Math.min(11, 340 / top.z));
      ctx.fillStyle = active ? ACCENT : 'rgba(255,255,255,.92)';
      ctx.strokeStyle = active ? ACCENT_D : 'rgba(60,80,100,.6)';
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(top.x, top.y, r, 0, 7); ctx.fill(); ctx.stroke();
      chip(ctx, top.x + r + 5, top.y, 'WP' + (k + 1) + ' · ' + w.alt + 'm',
        active ? '#0f4c93' : '#41525f', active ? 'rgba(226,238,252,.95)' : 'rgba(255,255,255,.86)', 10);
    }
    var hy = TH(home.x, home.z);
    var hp = proj(cam, home.x, hy + 1, home.z);
    if (hp) {
      var hs = Math.max(4, Math.min(12, 320 / hp.z));
      ctx.fillStyle = '#1d8a5f'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(hp.x, hp.y - hs); ctx.lineTo(hp.x + hs * 0.85, hp.y - hs * 0.25);
      ctx.lineTo(hp.x + hs * 0.5, hp.y - hs * 0.25); ctx.lineTo(hp.x + hs * 0.5, hp.y + hs * 0.7);
      ctx.lineTo(hp.x - hs * 0.5, hp.y + hs * 0.7); ctx.lineTo(hp.x - hs * 0.5, hp.y - hs * 0.25);
      ctx.lineTo(hp.x - hs * 0.85, hp.y - hs * 0.25);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  }

  /* ---- 3D 씬 (자유 시점) ---------------------------------------------- */
  function renderScene(ctx, W, H, o) {
    ctx.save();
    sky(ctx, W, H);
    var cam = makeCam(o.camPos, o.target, o.fov || 55, W, H, 0);
    drawTerrain3D(ctx, cam, o);
    if (o.showMarkers) drawMarkers3D(ctx, cam, o.waypoints, o.wpIdx, o.home, o.drone);
    if (o.showPath) {
      drawPath3D(ctx, cam, o.path, 'rgba(31,116,216,.22)', 6);
      drawPath3D(ctx, cam, o.path, ACCENT, 2.2);
    }
    // 고도 틱 (10m 눈금) — 드론 위치 기준
    var d = o.drone;
    for (var a = 10; a <= Math.max(10, Math.ceil(d.alt / 10) * 10); a += 10) {
      var tp = proj(cam, d.x, d.groundY + a, d.z);
      if (!tp) continue;
      ctx.strokeStyle = 'rgba(31,116,216,.30)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(tp.x - 6, tp.y); ctx.lineTo(tp.x + 6, tp.y); ctx.stroke();
    }
    drawDrone3D(ctx, cam, d, 7);
    // 짐벌 시야
    var yawR = (d.yaw + o.gimbalYaw) * DEG;
    var gp = (d.gimbalPitch) * DEG;
    var gy = d.groundY + d.alt;
    var far = 90;
    var L = [d.x + Math.sin(yawR - 0.52) * far, gy + Math.tan(gp) * far, d.z - Math.cos(yawR - 0.52) * far];
    var R = [d.x + Math.sin(yawR + 0.52) * far, gy + Math.tan(gp) * far, d.z - Math.cos(yawR + 0.52) * far];
    var O = proj(cam, d.x, gy, d.z), pl = proj(cam, L[0], L[1], L[2]), pr = proj(cam, R[0], R[1], R[2]);
    if (O && pl && pr) {
      ctx.fillStyle = 'rgba(31,116,216,.10)';
      ctx.beginPath(); ctx.moveTo(O.x, O.y); ctx.lineTo(pl.x, pl.y); ctx.lineTo(pr.x, pr.y); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(31,116,216,.35)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(O.x, O.y); ctx.lineTo(pl.x, pl.y); ctx.moveTo(O.x, O.y); ctx.lineTo(pr.x, pr.y); ctx.stroke();
    }
    // 지평선 기준선
    ctx.strokeStyle = 'rgba(60,80,100,.14)'; ctx.lineWidth = 1;
    ctx.setLineDash([2, 5]);
    ctx.beginPath(); ctx.moveTo(0, H * 0.5); ctx.lineTo(W, H * 0.5); ctx.stroke();
    ctx.setLineDash([]);
    if (window.DS_DEBUG) {
      ctx.fillStyle = 'rgba(0,0,0,.75)'; ctx.font = '10px monospace';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('q=' + (window.__quads | 0) + ' camY=' + cam.p[1].toFixed(0) +
        ' tgt=' + cam.p[0].toFixed(0) + ',' + cam.p[2].toFixed(0) + ' alt=' + d.alt.toFixed(1), 6, H - 46);
    }
    ctx.restore();
  }

  /* ---- 짐벌 카메라 뷰 -------------------------------------------------- */
  function renderCam(ctx, W, H, o) {
    ctx.save();
    var d = o.drone;
    var yawR = (d.yaw + o.gimbalYaw) * DEG;
    var gy = d.groundY + d.alt;
    var camPos = [d.x, gy, d.z];
    var dist = 620;
    var pitch = o.gimbalPitch * DEG;
    var target = [
      d.x + Math.sin(yawR) * Math.cos(pitch) * dist,
      gy + Math.sin(pitch) * dist,
      d.z - Math.cos(yawR) * Math.cos(pitch) * dist
    ];
    var fov = 78 / o.zoom;
    var cam = makeCam(camPos, target, fov, W, H, -d.roll);
    sky(ctx, W, H);
    var ext = 300 + d.alt * 1.8;
    drawTerrain3D(ctx, cam, { focus: [d.x + Math.sin(yawR) * 160, d.z - Math.cos(yawR) * 160], extent: ext, step: 34, maxQuads: 480 });
    // 카메라 HUD
    var hud = 'rgba(255,255,255,.92)';
    ctx.strokeStyle = hud; ctx.lineWidth = 1.6;
    // 코너 브래킷
    var m = 22, L = 26;
    var corners = [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]];
    for (var i = 0; i < 4; i++) {
      var c = corners[i];
      ctx.beginPath();
      ctx.moveTo(c[0] + c[2] * L, c[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(c[0], c[1] + c[3] * L);
      ctx.stroke();
    }
    // 조준선
    ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(W / 2 - 16, H / 2); ctx.lineTo(W / 2 - 5, H / 2);
    ctx.moveTo(W / 2 + 5, H / 2); ctx.lineTo(W / 2 + 16, H / 2);
    ctx.moveTo(W / 2, H / 2 - 16); ctx.lineTo(W / 2, H / 2 - 5);
    ctx.moveTo(W / 2, H / 2 + 5); ctx.lineTo(W / 2, H / 2 + 16);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 3, 0, 7); ctx.stroke();
    // 피치 래더
    ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1;
    var ppd = (H / 2) / Math.tan(fov * DEG / 2) * DEG;
    for (var pd = -30; pd <= 30; pd += 10) {
      var yy = H / 2 + (pd - o.gimbalPitch) * ppd;
      if (yy < 40 || yy > H - 40) continue;
      var wdt = pd === 0 ? 46 : 26;
      ctx.beginPath();
      ctx.moveTo(W / 2 - wdt, yy); ctx.lineTo(W / 2 - 8, yy);
      ctx.moveTo(W / 2 + 8, yy); ctx.lineTo(W / 2 + wdt, yy);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---- 2D 지도 -------------------------------------------------------- */
  /* 지형 래스터 캐시 — 뷰마다 별도 캐시를 갖는다.
     (지도와 미니맵이 캐시를 공유하면 매 틱마다 서로를 무효화해 버린다)
     셀 중심이 화면 중심에 오도록 격자를 만들고 캐시 원점은 3셀 단위로
     스냅한다 → |오프셋| ≤ 1.5셀이므로 항상 화면을 가득 채운다. */
  function newMapCache() { return { key: '', cv: null }; }
  function buildTerrain(cc, scx, scz, mpp, block, ci, cj, bw, bh, contrast) {
    var cv = cc.cv;
    if (!cv) { cv = document.createElement('canvas'); cc.cv = cv; }
    if (cv.width < bw * block || cv.height < bh * block) {
      cv.width = bw * block; cv.height = bh * block;
    }
    var c2 = cv.getContext('2d');
    c2.setTransform(1, 0, 0, 1, 0, 0);
    c2.clearRect(0, 0, bw * block, bh * block);
    var hg = [], bg = [], wg = [];
    for (var i = 0; i < bw; i++) {
      hg[i] = []; bg[i] = []; wg[i] = [];
      for (var j = 0; j < bh; j++) {
        var h = TH(scx + (i - ci) * mpp, scz + (j - cj) * mpp);
        hg[i][j] = h; bg[i][j] = Math.floor(h / 4.2); wg[i][j] = h < WATER;
      }
    }
    for (var a = 0; a < bw; a++) for (var b = 0; b < bh; b++) {
      var h0 = hg[a][b];
      var gx = (a < bw - 1 ? hg[a + 1][b] : h0) - h0;
      var gz = (b < bh - 1 ? hg[a][b + 1] : h0) - h0;
      var shade = clamp(-(gx * -0.62 + gz * -0.78) * 3.2, -1, 1);
      c2.fillStyle = wg[a][b] ? waterHSL(h0) : landHSL(h0, shade, contrast);
      c2.fillRect(a * block, b * block, block + 0.6, block + 0.6);
      if ((a < bw - 1 && bg[a + 1][b] !== bg[a][b]) || (b < bh - 1 && bg[a][b + 1] !== bg[a][b])) {
        c2.strokeStyle = wg[a][b] ? 'rgba(110,150,185,.4)' : 'rgba(62,86,74,.15)';
        c2.lineWidth = 1;
        c2.beginPath();
        c2.moveTo(a * block, b * block);
        c2.lineTo(a * block, (b + 1) * block);
        c2.lineTo((a + 1) * block, (b + 1) * block);
        c2.stroke();
      }
    }
    return { cv: cv, bw: bw, bh: bh, block: block, ci: ci, cj: cj };
  }

  function renderMap(ctx, W, H, o) {
    var cc = o.cache || (o.cache = newMapCache());
    var ppm = o.ppm, cx = o.cx, cz = o.cz;
    var block = clamp(Math.round(Math.max(W, H) / 190), 3, 24);
    var mpp = block / ppm;
    var ci = Math.round(W / 2 / block), cj = Math.round(H / 2 / block);
    var bw = Math.ceil(W / block) + 3, bh = Math.ceil(H / block) + 3;
    var snap = 3 * mpp;
    var scx = Math.round(cx / snap) * snap, scz = Math.round(cz / snap) * snap;
    var key = W + 'x' + H + '|' + scx.toFixed(2) + '|' + scz.toFixed(2) + '|' + mpp.toFixed(3) + '|' + block;
    if (cc.key !== key) {
      cc.ter = buildTerrain(cc, scx, scz, mpp, block, ci, cj, bw, bh, 0.09);
      cc.key = key;
    }
    ctx.save();
    ctx.fillStyle = 'hsl(45 20% 97%)';
    ctx.fillRect(0, 0, W, H);
    var ox = W / 2 + (scx - cx) * ppm - ci * block;
    var oy = H / 2 + (scz - cz) * ppm - cj * block;
    ctx.drawImage(cc.ter.cv, 0, 0, bw * block, bh * block, ox, oy, bw * block, bh * block);

    var s = function (x, z) { return [W / 2 + (x - cx) * ppm, H / 2 + (z - cz) * ppm]; };

    // 도로
    ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    for (var r = 0; r < ROADS.length; r++) {
      ctx.beginPath();
      for (var i = 0; i < ROADS[r].length; i++) {
        var p = s(ROADS[r][i][0], ROADS[r][i][1]);
        i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(150,160,165,.55)'; ctx.lineWidth = 1;
    for (var r2 = 0; r2 < ROADS.length; r2++) {
      ctx.beginPath();
      for (var i2 = 0; i2 < ROADS[r2].length; i2++) {
        var p2 = s(ROADS[r2][i2][0], ROADS[r2][i2][1]);
        i2 ? ctx.lineTo(p2[0], p2[1]) : ctx.moveTo(p2[0], p2[1]);
      }
      ctx.stroke();
    }

    // 좌표 그리드
    if (o.showGrid) {
      var grid = ppm > 1.4 ? 50 : 100;
      ctx.strokeStyle = 'rgba(60,80,100,.10)'; ctx.lineWidth = 1;
      ctx.font = '500 9.5px "IBM Plex Mono", monospace';
      ctx.fillStyle = 'rgba(70,90,110,.6)'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      var x0 = Math.floor((cx - W / 2 / ppm) / grid) * grid;
      for (var gx = x0; gx < cx + W / 2 / ppm + grid; gx += grid) {
        var px = W / 2 + (gx - cx) * ppm;
        ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
        ctx.fillText(gx.toFixed(0), px + 3, 4);
      }
      var z0 = Math.floor((cz - H / 2 / ppm) / grid) * grid;
      for (var gz = z0; gz < cz + H / 2 / ppm + grid; gz += grid) {
        var py = H / 2 + (gz - cz) * ppm;
        ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(W, py); ctx.stroke();
        ctx.fillText(gz.toFixed(0), 4, py + 3);
      }
    }

    // 지오펜스
    if (o.showFence) {
      var hp = s(o.home.x, o.home.z);
      ctx.setLineDash([7, 6]);
      ctx.strokeStyle = 'rgba(196,120,20,.55)'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(hp[0], hp[1], o.fence * ppm, 0, 7); ctx.stroke();
      ctx.setLineDash([]);
    }

    // 임무 경로
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = 'rgba(31,116,216,.6)'; ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (var w = 0; w < o.waypoints.length; w++) {
      var pw = s(o.waypoints[w].x, o.waypoints[w].z);
      w ? ctx.lineTo(pw[0], pw[1]) : ctx.moveTo(pw[0], pw[1]);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // 비행 궤적
    if (o.showTrail && o.path.length > 1) {
      ctx.strokeStyle = 'rgba(31,116,216,.18)'; ctx.lineWidth = 7; ctx.lineJoin = 'round';
      ctx.beginPath();
      for (var t = 0; t < o.path.length; t++) {
        var pt = s(o.path[t].x, o.path[t].z);
        t ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1]);
      }
      ctx.stroke();
      ctx.strokeStyle = ACCENT; ctx.lineWidth = 2.2;
      ctx.stroke();
    }

    // 홈 마커
    var hm = s(o.home.x, o.home.z);
    ctx.fillStyle = '#1d8a5f'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(hm[0], hm[1], 7, 0, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = '700 9px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('H', hm[0], hm[1] + 0.5);

    // 웨이포인트
    for (var k = 0; k < o.waypoints.length; k++) {
      var wp = o.waypoints[k], wp2 = s(wp.x, wp.z);
      var act = k === o.wpIdx;
      ctx.fillStyle = act ? ACCENT : 'rgba(255,255,255,.95)';
      ctx.strokeStyle = act ? ACCENT_D : 'rgba(70,90,110,.7)';
      ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.arc(wp2[0], wp2[1], act ? 9 : 7.5, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = act ? '#fff' : '#3a4b59';
      ctx.font = '700 10px "IBM Plex Mono", monospace';
      ctx.fillText(String(k + 1), wp2[0], wp2[1] + 0.5);
      if (act) {
        ctx.strokeStyle = 'rgba(31,116,216,.5)'; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(wp2[0], wp2[1], 15 + Math.sin(Date.now() / 320) * 2.5, 0, 7); ctx.stroke();
      }
    }

    // 드론 + 카메라 시야
    var dp = s(o.drone.x, o.drone.z);
    var yaw = o.drone.yaw * DEG;
    var fov = 34 * DEG;
    ctx.fillStyle = 'rgba(31,116,216,.13)';
    ctx.beginPath();
    ctx.moveTo(dp[0], dp[1]);
    ctx.arc(dp[0], dp[1], 190 * ppm, yaw - Math.PI / 2 - fov, yaw - Math.PI / 2 + fov);
    ctx.closePath(); ctx.fill();
    ctx.save();
    ctx.translate(dp[0], dp[1]); ctx.rotate(yaw);
    ctx.fillStyle = ACCENT_D;
    ctx.beginPath();
    ctx.moveTo(0, -11); ctx.lineTo(7.5, 8); ctx.lineTo(0, 4.5); ctx.lineTo(-7.5, 8);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.restore();

    // 축척 + 방위
    var barM = ppm > 1.4 ? 50 : ppm > 0.7 ? 100 : 200;
    var bw = barM * ppm;
    ctx.strokeStyle = 'rgba(40,60,80,.7)'; ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(W - 24 - bw, H - 26); ctx.lineTo(W - 24, H - 26);
    ctx.moveTo(W - 24 - bw, H - 30); ctx.lineTo(W - 24 - bw, H - 22);
    ctx.moveTo(W - 24, H - 30); ctx.lineTo(W - 24, H - 22);
    ctx.stroke();
    ctx.fillStyle = 'rgba(40,60,80,.85)';
    ctx.font = '600 10px "IBM Plex Mono", monospace';
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText(barM + ' m', W - 24, H - 32);
    ctx.save();
    ctx.translate(30, 34); ctx.rotate(0);
    ctx.strokeStyle = 'rgba(40,60,80,.8)'; ctx.fillStyle = 'rgba(40,60,80,.8)';
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(0, 9); ctx.lineTo(0, -9); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -13); ctx.lineTo(4.5, -4); ctx.lineTo(-4.5, -4); ctx.closePath(); ctx.fill();
    ctx.font = '700 9px "IBM Plex Mono", monospace'; ctx.textAlign = 'center';
    ctx.fillText('N', 0, -16);
    ctx.restore();
    ctx.restore();
  }

  var ROADS = [
    [[-560, -340], [-260, -190], [-20, -70], [230, 90], [540, 250]],
    [[-540, 300], [-300, 160], [-60, 80], [180, -110], [460, -290]]
  ];

  window.DroneRender = { renderMap: renderMap, renderScene: renderScene, renderCam: renderCam, newMapCache: newMapCache, ACCENT: ACCENT, rrect: rrect };
})();
