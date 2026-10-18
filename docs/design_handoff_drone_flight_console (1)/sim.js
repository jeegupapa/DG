/* ==========================================================================
   DroneSim — 비행 시뮬레이션 엔진 (프레임워크 없음, 순수 JS)
   월드 좌표계: x = 동(+), z = 남(+) → 지도에서 북쪽이 위.
   yaw 0° = 북(-z) 방향. 고도(alt)는 지표면 기준 AGL.
   ========================================================================== */
(function () {
  var DEG = Math.PI / 180;
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var damp = function (cur, tgt, tau, dt) { return cur + (tgt - cur) * (1 - Math.exp(-dt / tau)); };
  var wrap180 = function (d) { d = ((d + 180) % 360 + 360) % 360 - 180; return d; };

  /* ---- 지형 높이장 (결정적) ------------------------------------------- */
  function terrainH(x, z) {
    return (
      9.0 * Math.sin(x / 95) * Math.cos(z / 115) +
      5.2 * Math.sin((x + z * 0.6) / 58) +
      3.2 * Math.cos((z - x * 0.5) / 37) +
      1.6 * Math.sin((x * 0.31 + z * 0.27) / 17)
    );
  }
  var WATER = -7.2;

  var MAX_SPEED = 18;      // m/s 수평 최대
  var MAX_VS = 5;          // m/s 수직 최대
  var MAX_YAW_RATE = 70;   // deg/s

  var MODE_KR = {
    IDLE: '대기', MANUAL: '수동', AUTO: '자동 임무', HOLD: '호버 홀드',
    TAKEOFF: '이륙', RTL: '귀환', LAND: '착륙'
  };

  var DEFAULT_WPS = [
    { x: 132, z: -96, alt: 45, hover: 4 },
    { x: 248, z: 58, alt: 62, hover: 6 },
    { x: 58, z: 198, alt: 72, hover: 5 },
    { x: -158, z: 96, alt: 55, hover: 6 },
    { x: -96, z: -148, alt: 42, hover: 3 }
  ];

  var S = {
    t: 0, simSpeed: 1, running: true,
    mode: 'IDLE', armed: false, motorsOn: false,
    x: 0, z: 0, alt: 0, yaw: 0, pitch: 0, roll: 0,
    vx: 0, vz: 0, vv: 0, vh: 0,
    battery: 100, cellV: 4.18, sats: 16, hdop: 0.8,
    windSpd: 2.6, windDir: 45, gust: 0, temp: 21.4,
    gimbalPitch: -18, gimbalTarget: -18, zoom: 1.0,
    flightTime: 0, dist: 0, maxAlt: 0, maxSpd: 0,
    targetAlt: 45, cruise: 9,
    missionIdx: 0, wpState: 'transit', hoverT: 0, missionActive: false,
    home: { x: 0, z: 0 },
    waypoints: DEFAULT_WPS.map(function (w) { return { x: w.x, z: w.z, alt: w.alt, hover: w.hover }; }),
    trail: [], hist: [], events: [],
    stick: { lx: 0, ly: 0, rx: 0, ry: 0 },
    keys: {}, manualOverride: true, fence: 420,
    input: { thr: 0, yaw: 0, pitch: 0, roll: 0 },
    modeSince: 0, groundY: 0, msl: 0, distHome: 0, remainMin: 22, rpm: 0,
    showGrid: true, showTrail: true, showMarkers: true, showFence: true, camMode: 'orbit'
  };

  var evId = 0;
  function log(level, text) {
    evId++;
    S.events.unshift({ id: evId, t: S.t, level: level, text: text });
    if (S.events.length > 48) S.events.pop();
  }

  function setMode(m, silent) {
    if (S.mode === m) return;
    S.mode = m; S.modeSince = S.t;
    if (!silent) log('info', '모드 전환 · ' + MODE_KR[m]);
  }

  function reset(keepMission) {
    S.t = 0; S.mode = 'IDLE'; S.armed = false; S.motorsOn = false;
    S.x = 0; S.z = 0; S.alt = 0; S.yaw = 0; S.pitch = 0; S.roll = 0;
    S.vx = S.vz = S.vv = S.vh = 0;
    S.battery = 100; S.cellV = 4.18;
    S.flightTime = 0; S.dist = 0; S.maxAlt = 0; S.maxSpd = 0;
    S.missionIdx = 0; S.wpState = 'transit'; S.hoverT = 0;
    S.trail = []; S.hist = []; S.events = [];
    S.stick = { lx: 0, ly: 0, rx: 0, ry: 0 };
    S.input = { thr: 0, yaw: 0, pitch: 0, roll: 0 };
    S.gimbalPitch = S.gimbalTarget = -18; S.zoom = 1;
    if (!keepMission) S.missionActive = false;
    log('info', '시뮬레이터 초기화 · 홈 포인트 (0, 0)');
  }

  function arm() {
    if (S.armed) return;
    S.armed = true; S.motorsOn = true;
    log('ok', '모터 ARM · 자이로/가속도 캘리브레이션 완료');
  }

  function takeoff(alt) {
    if (S.battery < 8) { log('crit', '이륙 거부 · 배터리 부족'); return; }
    if (!S.armed) arm();
    S.targetAlt = alt || S.targetAlt || 45;
    setMode('TAKEOFF');
    log('ok', '이륙 · 목표 고도 ' + S.targetAlt.toFixed(0) + ' m');
  }

  function auto() {
    if (!S.armed) arm();
    if (S.alt < 2) { takeoff(S.targetAlt); S.missionActive = true; return; }
    S.missionIdx = 0; S.wpState = 'transit'; S.missionActive = true;
    setMode('AUTO');
    log('ok', '임무 시작 · 웨이포인트 ' + S.waypoints.length + '개');
  }

  function hold() { setMode('HOLD'); }
  function rtl() {
    if (!S.armed) return;
    setMode('RTL'); log('warn', '귀환 모드 · 홈 포인트로 복귀');
  }
  function land() {
    if (!S.armed) return;
    setMode('LAND'); log('warn', '착륙 시퀀스 시작 · 하강률 1.1 m/s');
  }
  function scenario() {
    reset(true);
    S.targetAlt = 45; S.cruise = 9;
    arm();
    setTimeout(function () { if (S.mode === 'IDLE') takeoff(45); }, 700);
    setTimeout(function () { if (S.alt > 8) { S.missionIdx = 0; S.wpState = 'transit'; S.missionActive = true; setMode('AUTO'); } }, 6200);
  }

  /* ---- 비행 제어 ------------------------------------------------------ */
  function faceTo(bearing, dt) {
    var err = wrap180(bearing - S.yaw);
    var rate = clamp(err * 1.9, -MAX_YAW_RATE, MAX_YAW_RATE);
    S.yaw = ((S.yaw + rate * dt) % 360 + 360) % 360;
  }

  function stickMag() {
    var s = S.stick;
    return Math.max(Math.abs(s.lx), Math.abs(s.ly), Math.abs(s.rx), Math.abs(s.ry));
  }

  function manualControl(dt) {
    var k = S.keys, s = S.stick;
    var yaw = s.lx + (k.ArrowRight ? 1 : 0) + (k.ArrowLeft ? -1 : 0) + (k.d ? 1 : 0) + (k.a ? -1 : 0);
    var thr = -s.ly + (k.ArrowUp ? 1 : 0) + (k.ArrowDown ? -1 : 0) + (k.w ? 1 : 0) + (k.s ? -1 : 0);
    var pit = -s.ry + (k.Shift ? 1 : 0);
    var rol = s.rx + (k.Space ? 1 : 0);
    yaw = clamp(yaw, -1, 1); thr = clamp(thr, -1, 1); pit = clamp(pit, -1, 1); rol = clamp(rol, -1, 1);
    S.input = { thr: thr, yaw: yaw, pitch: pit, roll: rol };

    var cy = Math.cos(S.yaw * DEG), sy = Math.sin(S.yaw * DEG);
    var fx = sy, fz = -cy, rx = cy, rz = sy;
    var tvx = (fx * pit + rx * rol) * MAX_SPEED;
    var tvz = (fz * pit + rz * rol) * MAX_SPEED;
    S.vx = damp(S.vx, tvx, 0.95, dt);
    S.vz = damp(S.vz, tvz, 0.95, dt);
    S.yaw = ((S.yaw + yaw * MAX_YAW_RATE * dt) % 360 + 360) % 360;
    var vvT = Math.abs(thr) < 0.07 ? 0 : thr * MAX_VS;
    S.vv = damp(S.vv, vvT, 0.7, dt);
    if (!S.armed) { S.vx = damp(S.vx, 0, 0.5, dt); S.vz = damp(S.vz, 0, 0.5, dt); S.vv = damp(S.vv, 0, 0.5, dt); }
  }

  function holdControl(dt) {
    S.vx = damp(S.vx, 0, 0.6, dt); S.vz = damp(S.vz, 0, 0.6, dt);
    S.vv = damp(S.vv, clamp((S.targetAlt - S.alt) * 0.5, -2.5, 2.5), 0.7, dt);
    S.input = { thr: 0, yaw: 0, pitch: 0, roll: 0 };
  }

  function takeoffControl(dt) {
    S.vx = damp(S.vx, 0, 0.7, dt); S.vz = damp(S.vz, 0, 0.7, dt);
    S.vv = damp(S.vv, clamp((S.targetAlt - S.alt) * 0.6, -2.5, 3.0), 0.6, dt);
    S.input = { thr: clamp(S.vv / MAX_VS, -1, 1), yaw: 0, pitch: 0, roll: 0 };
    if (Math.abs(S.alt - S.targetAlt) < 2.2 && S.vv < 0.4) {
      if (S.missionActive) { S.missionIdx = 0; S.wpState = 'transit'; setMode('AUTO'); }
      else { setMode('HOLD'); log('ok', '목표 고도 도달 · 호버 유지'); }
    }
  }

  function autoControl(dt) {
    var wps = S.waypoints;
    if (S.missionIdx >= wps.length) { S.missionActive = false; rtl(); return; }
    var wp = wps[S.missionIdx];
    var dx = wp.x - S.x, dz = wp.z - S.z;
    var d = Math.hypot(dx, dz);
    var bearing = Math.atan2(dx, -dz) / DEG;
    var altErr = wp.alt - S.alt;

    if (S.wpState === 'hover') {
      S.hoverT -= dt;
      S.vx = damp(S.vx, 0, 0.5, dt); S.vz = damp(S.vz, 0, 0.5, dt);
      S.vv = damp(S.vv, clamp(altErr * 0.6, -2, 2), 0.6, dt);
      faceTo(bearing, dt);
      if (S.hoverT <= 0) {
        S.missionIdx++; S.wpState = 'transit';
        if (S.missionIdx < wps.length) log('info', '다음 목표 · WP' + (S.missionIdx + 1) + ' (' + wps[S.missionIdx].alt + ' m)');
      }
      return;
    }
    var arrive = d < 6.5;
    var yawErr = wrap180(bearing - S.yaw);
    faceTo(bearing, dt);
    var align = clamp(Math.cos(yawErr * DEG), 0, 1);
    var vTgt = arrive ? Math.min(d * 0.5, 1.4) : clamp(d * 0.42, 2.4, S.cruise);
    var v = vTgt * (0.22 + 0.78 * align);
    S.vx = damp(S.vx, Math.sin(bearing * DEG) * v, 0.9, dt);
    S.vz = damp(S.vz, -Math.cos(bearing * DEG) * v, 0.9, dt);
    S.vv = damp(S.vv, clamp(altErr * 0.55, -2.6, 2.6), 0.7, dt);
    S.input = { thr: clamp(S.vv / MAX_VS, -1, 1), yaw: 0, pitch: clamp(v / MAX_SPEED, 0, 1), roll: 0 };
    if (arrive && Math.abs(altErr) < 3.5) {
      S.wpState = 'hover'; S.hoverT = wp.hover || 3;
      log('ok', 'WP' + (S.missionIdx + 1) + ' 도착 · ' + (wp.hover || 3) + '초 호버');
    }
  }

  function rtlControl(dt) {
    var dx = S.home.x - S.x, dz = S.home.z - S.z, d = Math.hypot(dx, dz);
    var bearing = Math.atan2(dx, -dz) / DEG;
    var rAlt = Math.max(48, S.targetAlt);
    faceTo(bearing, dt);
    if (d > 7) {
      var v = clamp(d * 0.4, 2, Math.max(7, S.cruise));
      S.vx = damp(S.vx, Math.sin(bearing * DEG) * v, 0.9, dt);
      S.vz = damp(S.vz, -Math.cos(bearing * DEG) * v, 0.9, dt);
      S.vv = damp(S.vv, clamp((rAlt - S.alt) * 0.5, -2, 2), 0.7, dt);
      S.input = { thr: clamp(S.vv / MAX_VS, -1, 1), yaw: 0, pitch: clamp(v / MAX_SPEED, 0, 1), roll: 0 };
    } else {
      setMode('LAND'); log('warn', '홈 상공 도착 · 착륙 시퀀스 시작');
    }
  }

  function landControl(dt) {
    S.vx = damp(S.vx, 0, 1.1, dt); S.vz = damp(S.vz, 0, 1.1, dt);
    S.vv = damp(S.vv, -1.1, 0.9, dt);
    S.input = { thr: -0.25, yaw: 0, pitch: 0, roll: 0 };
    if (S.alt <= 0.35) {
      S.alt = 0; S.vv = 0; S.vx = S.vz = 0;
      setMode('IDLE'); S.motorsOn = false; S.armed = false;
      log('ok', '터치다운 완료 · 모터 정지 · 비행시간 ' + fmtTime(S.flightTime));
    }
  }

  function fmtTime(s) {
    var m = Math.floor(s / 60), ss = Math.floor(s % 60);
    return m + ':' + (ss < 10 ? '0' : '') + ss;
  }

  /* ---- 메인 틱 -------------------------------------------------------- */
  function tick(dt) {
    if (!S.running || dt <= 0) return;
    S.t += dt;

    // 바람 / 돌풍
    S.windDir = (S.windDir + dt * 3.1) % 360;
    S.windSpd = 2.4 + 1.3 * Math.sin(S.t / 47) + 0.5 * Math.sin(S.t / 7.3);
    var gp = S.t % 19;
    S.gust = gp < 3.4 ? Math.sin((gp / 3.4) * Math.PI) * 3.6 : 0;

    // 자동 모드에서 스틱 개입 → 수동 전환
    if (S.manualOverride && (S.mode === 'AUTO' || S.mode === 'RTL' || S.mode === 'HOLD') && stickMag() > 0.5) {
      setMode('MANUAL'); S.missionActive = false;
      log('warn', '조종 입력 감지 · 수동 모드로 전환');
    }

    var pvx = S.vx, pvz = S.vz;

    if (S.mode === 'MANUAL') manualControl(dt);
    else if (S.mode === 'TAKEOFF') takeoffControl(dt);
    else if (S.mode === 'AUTO') autoControl(dt);
    else if (S.mode === 'HOLD') holdControl(dt);
    else if (S.mode === 'RTL') rtlControl(dt);
    else if (S.mode === 'LAND') landControl(dt);
    else { S.vx = damp(S.vx, 0, 0.8, dt); S.vz = damp(S.vz, 0, 0.8, dt); S.vv = damp(S.vv, 0, 0.8, dt); }

    // 위치 적분
    var px = S.x, pz = S.z;
    S.x += S.vx * dt; S.z += S.vz * dt;
    S.alt = Math.max(0, S.alt + S.vv * dt);
    S.vh = Math.hypot(S.vx, S.vz);
    var moved = Math.hypot(S.x - px, S.z - pz);
    S.dist += moved;

    // 자세 (가속도 + 스틱 + 바람)
    var ax = (S.vx - pvx) / Math.max(dt, 1e-4), az = (S.vz - pvz) / Math.max(dt, 1e-4);
    var cy = Math.cos(S.yaw * DEG), sy = Math.sin(S.yaw * DEG);
    var fwdAcc = ax * sy + az * -cy;
    var latAcc = ax * cy + az * sy;
    var windP = Math.sin(S.t * 2.7) * (S.windSpd + S.gust) * 0.55;
    var windR = Math.cos(S.t * 2.15) * (S.windSpd + S.gust) * 0.75;
    var pitchT = clamp(-fwdAcc * 1.5, -20, 20) + S.input.pitch * 12 + windP;
    var rollT = clamp(latAcc * 1.5, -20, 20) + S.input.roll * 12 + windR;
    if (!S.armed) { pitchT = windP * 0.3; rollT = windR * 0.3; }
    S.pitch = damp(S.pitch, clamp(pitchT, -34, 34), 0.3, dt);
    S.roll = damp(S.roll, clamp(rollT, -34, 34), 0.3, dt);

    // 배터리 / 전력
    var load = 0.072 + 0.030 * Math.abs(S.input.thr) + 0.030 * (S.vh / MAX_SPEED) + 0.02 * Math.max(0, S.vv / MAX_VS);
    if (S.armed) {
      S.battery = clamp(S.battery - load * dt, 0, 100);
      S.flightTime += dt;
      S.remainMin = (S.battery / Math.max(load, 1e-3)) / 60;
    }
    S.cellV = 3.45 + (S.battery / 100) * 0.76 - (S.armed ? 0.05 * (load / 0.1) : 0);
    S.rpm = S.armed ? 4200 + S.input.thr * 900 + S.vh * 120 + Math.sin(S.t * 31) * 60 : 0;

    // GNSS
    S.sats = clamp(Math.round(15 + 1.6 * Math.sin(S.t / 38) + 0.8 * Math.sin(S.t / 3.1) - S.gust * 0.8), 5, 20);
    S.hdop = clamp(0.7 + (20 - S.sats) * 0.085, 0.5, 2.4);

    // 짐벌
    S.gimbalTarget = -18 + Math.sin(S.t / 21) * 9;
    S.gimbalPitch = damp(S.gimbalPitch, S.gimbalTarget, 1.4, dt);

    S.maxAlt = Math.max(S.maxAlt, S.alt);
    S.maxSpd = Math.max(S.maxSpd, S.vh);
    S.groundY = terrainH(S.x, S.z);
    S.msl = S.groundY + S.alt;
    S.distHome = Math.hypot(S.x - S.home.x, S.z - S.home.z);

    // 경고 이벤트 (래치)
    if (S.battery < 25 && !S._w25) { S._w25 = true; log('warn', '배터리 25% 이하 · 임무 단축 권장'); }
    if (S.battery < 15 && !S._w15) { S._w15 = true; log('crit', '배터리 15% 이하 · 즉시 귀환 필요'); }
    if (S.battery < 15 && S.mode !== 'RTL' && S.mode !== 'LAND' && S.armed) rtl();
    if (S.battery <= 0 && S.mode !== 'LAND' && S.mode !== 'IDLE') { setMode('LAND'); log('crit', '배터리 방전 · 자동 착륙'); }
    if (S.sats < 9 && !S._ws) { S._ws = true; log('warn', 'GNSS 위성 부족 (' + S.sats + ') · 위치 정밀도 저하'); }
    if (S.sats >= 11) S._ws = false;
    if (S.distHome > S.fence && !S._wf) { S._wf = true; log('warn', '지오펜스 경계 접근 · 반경 ' + S.fence + ' m 초과'); }
    if (S.distHome < S.fence - 40) S._wf = false;
    if (S.gust > 3 && !S._wg) { S._wg = true; log('warn', '강풍 돌풍 감지 · ' + (S.windSpd + S.gust).toFixed(1) + ' m/s'); }
    if (S.gust < 1) S._wg = false;

    // 궤적 / 이력 샘플링
    var last = S.trail[S.trail.length - 1];
    if (!last || Math.hypot(S.x - last.x, S.z - last.z) > 1.4 || Math.abs(S.alt - last.alt) > 1.5) {
      S.trail.push({ x: S.x, z: S.z, alt: S.alt });
      if (S.trail.length > 2200) S.trail.shift();
    }
    if (!S._hT || S.t - S._hT > 0.25) {
      S._hT = S.t;
      S.hist.push({ t: S.t, spd: S.vh * 3.6, alt: S.alt, bat: S.battery, dist: S.distHome });
      if (S.hist.length > 360) S.hist.shift();
    }
  }

  /* ---- 루프 (고정 스텝 누산기) ---------------------------------------- */
  var acc = 0;
  window.Tick.add(function (dtMs) {
    acc += Math.min(0.2, dtMs / 1000) * S.simSpeed;
    var step = 1 / 60, guard = 0;
    while (acc >= step && guard < 20) { tick(step); acc -= step; guard++; }
    if (guard >= 20) acc = 0;
  });

  reset();
  S.missionActive = false;

  window.DroneSim = {
    state: S, terrainH: terrainH, WATER: WATER,
    MAX_SPEED: MAX_SPEED, MAX_VS: MAX_VS, MODE_KR: MODE_KR,
    clamp: clamp, wrap180: wrap180, fmtTime: fmtTime,
    reset: reset, arm: arm, takeoff: takeoff, auto: auto, hold: hold,
    rtl: rtl, land: land, scenario: scenario, log: log, setMode: setMode
  };
})();
