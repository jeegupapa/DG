/* ==========================================================================
   panels.jsx — 텔레메트리 / 계기 / 임무 / 이벤트 로그 패널
   ========================================================================== */
const PS = { useRef, useEffect, useState, useCallback };

function fmt(v, d) { return v.toFixed(d === undefined ? 1 : d); }

/* ---------------- 텔레메트리 스트립 ---------------- */
function Telemetry() {
  const [d, setD] = PS.useState(snapshot());
  PS.useEffect(() => {
    const id = setInterval(() => setD(snapshot()), 110);
    return () => clearInterval(id);
  }, []);
  const U = window.SimUtil, S = window.SimU;
  const batTone = d.battery < 15 ? 'crit' : d.battery < 30 ? 'warn' : '';
  return (
    <div className="tstrip">
      <Readout label="수평 속도" value={fmt(U.spd(d.vh))} unit={U.spdU()}
        sub={'최대 ' + fmt(U.spd(d.maxSpd))} />
      <Readout label="수직 속도" value={(d.vv >= 0 ? '+' : '') + fmt(d.vv)} unit="m/s"
        sub={d.vv > 0.3 ? '상승' : d.vv < -0.3 ? '하강' : '유지'} />
      <Readout label="고도 AGL" value={fmt(U.alt(d.alt))} unit={U.altU()}
        sub={'MSL ' + fmt(U.alt(d.msl)) + ' ' + U.altU()} />
      <Readout label="홈 거리" value={fmt(U.dist(d.distHome), 0)} unit={U.distU()}
        sub={'누적 ' + fmt(U.dist(d.dist), 0) + ' ' + U.distU()} />
      <Readout label="배터리" value={fmt(d.battery, 0)} unit="%"
        sub={fmt(d.cellV, 2) + ' V/cell · ' + fmt(d.remainMin, 0) + '분'} tone={batTone} />
      <Readout label="비행 시간" value={U.time(d.flightTime)} unit=""
        sub={'최대고도 ' + fmt(U.alt(d.maxAlt), 0) + ' ' + U.altU()} />
      <Readout label="자세" value={(d.yaw).toFixed(0) + '\u00b0'} unit=""
        sub={'P ' + fmt(d.pitch) + ' / R ' + fmt(d.roll)} />
      <Readout label="GNSS" value={d.sats} unit="기"
        sub={'HDOP ' + fmt(d.hdop, 2) + (d.sats < 10 ? ' · 저하' : ' · 양호')}
        tone={d.sats < 10 ? 'warn' : ''} />
      <Readout label="바람" value={fmt(d.windSpd + d.gust)} unit="m/s"
        sub={U.bearing(d.windDir) + ' · ' + fmt(d.temp) + '\u00b0C'} />
      <Readout label="모터" value={fmt(d.rpm / 1000)} unit="k rpm"
        sub={'부하 ' + fmt(Math.abs(d.input.thr) * 100, 0) + '%'} />
    </div>
  );
}

function snapshot() {
  const d = window.DroneSim.state;
  return {
    vh: d.vh, vv: d.vv, alt: d.alt, msl: d.msl, distHome: d.distHome, dist: d.dist,
    battery: d.battery, cellV: d.cellV, remainMin: d.remainMin, flightTime: d.flightTime,
    maxAlt: d.maxAlt, maxSpd: d.maxSpd, yaw: d.yaw, pitch: d.pitch, roll: d.roll,
    sats: d.sats, hdop: d.hdop, windSpd: d.windSpd, gust: d.gust, windDir: d.windDir,
    temp: d.temp, rpm: d.rpm, input: { thr: d.input.thr },
    targetAlt: d.targetAlt, cruise: d.cruise, gimbalPitch: d.gimbalPitch, zoom: d.zoom,
    running: d.running, simSpeed: d.simSpeed, mode: d.mode
  };
}

/* ---------------- 계기판 묶음 ---------------- */
function Instruments({ layout }) {
  const [d, setD] = PS.useState(snapshot());
  PS.useEffect(() => {
    const id = setInterval(() => setD(snapshot()), 110);
    return () => clearInterval(id);
  }, []);
  const U = window.SimUtil;
  return (
    <div className={'inst inst-' + layout}>
      <div className="inst-main">
        <div className="inst-att"><Attitude /></div>
        <div className="inst-tapes">
          <div className="tape-box">
            <div className="tb-l">고도 테이프 <b>{U.altU()}</b></div>
            <div className="tb-c"><AltTape /></div>
          </div>
        </div>
      </div>
      <div className="inst-bot">
        <div className="spd-box">
          <SpeedTape />
        </div>
      </div>
      <div className="inst-rows">
        <div className="kv"><span>목표 고도</span><b>{fmt(U.alt(d.targetAlt), 0)} {U.altU()}</b></div>
        <div className="kv"><span>목표 속도</span><b>{fmt(U.spd(d.cruise), 0)} {U.spdU()}</b></div>
        <div className="kv"><span>짐벌 피치</span><b>{fmt(d.gimbalPitch)}°</b></div>
        <div className="kv"><span>줌</span><b>{fmt(d.zoom)}×</b></div>
      </div>
    </div>
  );
}

/* ---------------- 이벤트 로그 ---------------- */
const LV_KR = { ok: '정상', info: '정보', warn: '주의', crit: '경고' };
function EventLog({ filter }) {
  const [ev, setEv] = PS.useState(window.DroneSim.state.events.slice());
  PS.useEffect(() => {
    const id = setInterval(() => {
      const src = window.DroneSim.state.events;
      setEv(prev => (prev.length === src.length && prev[0] && src[0] && prev[0].id === src[0].id ? prev : src.slice()));
    }, 200);
    return () => clearInterval(id);
  }, []);
  const list = filter && filter !== 'all' ? ev.filter(e => e.level === filter) : ev;
  return (
    <div className="log">
      {list.length === 0 && <div className="log-empty">기록된 이벤트 없음</div>}
      {list.map(e => (
        <div className={'log-row log-' + e.level} key={e.id}>
          <span className="log-t">{window.SimUtil.time(e.t)}</span>
          <span className="log-lv">{LV_KR[e.level]}</span>
          <span className="log-tx">{e.text}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------------- 미션 리스트 ---------------- */
function MissionList() {
  const [d, setD] = PS.useState(snapshot2());
  PS.useEffect(() => {
    const id = setInterval(() => setD(snapshot2()), 150);
    return () => clearInterval(id);
  }, []);
  const U = window.SimUtil;
  return (
    <div className="mlist">
      {d.wps.map((w, i) => {
        const dist = Math.hypot(w.x - d.x, w.z - d.z);
        const active = i === d.idx;
        const done = i < d.idx;
        return (
          <div className={'mrow' + (active ? ' active' : '') + (done ? ' done' : '')} key={i}>
            <span className="mno">{i + 1}</span>
            <span className="mname">WP{i + 1}</span>
            <span className="malt">{fmt(U.alt(w.alt), 0)} {U.altU()}</span>
            <span className="mhold">{w.hover}s</span>
            <span className="mdist">{done ? '완료' : fmt(U.dist(dist), 0) + ' ' + U.distU()}</span>
          </div>
        );
      })}
    </div>
  );
}
function snapshot2() {
  const d = window.DroneSim.state;
  return { wps: d.waypoints, idx: d.missionIdx, x: d.x, z: d.z };
}

/* ---------------- 배터리 / 셀 ---------------- */
function BatteryPanel() {
  const [d, setD] = PS.useState(snapshot());
  PS.useEffect(() => {
    const id = setInterval(() => setD(snapshot()), 130);
    return () => clearInterval(id);
  }, []);
  const cells = 4;
  return (
    <div className="bat">
      <div className="bat-head">
        <span>배터리 팩</span>
        <b className={d.battery < 20 ? 'crit' : d.battery < 35 ? 'warn' : ''}>{fmt(d.battery, 0)}%</b>
      </div>
      <div className="bat-cells">
        {Array.from({ length: cells }).map((_, i) => {
          const v = d.cellV + (i % 2 ? 0.006 : -0.006);
          const pct = Math.max(0, Math.min(1, (v - 3.45) / 0.76)) * 100;
          return (
            <div className="cell" key={i}>
              <div className="cell-bar"><i style={{ height: pct + '%' }} /></div>
              <div className="cell-v">{fmt(v, 2)}</div>
            </div>
          );
        })}
      </div>
      <div className="bat-foot">
        <span>전압 {fmt(d.cellV * cells, 2)} V</span>
        <span>잔여 {fmt(d.remainMin, 0)} 분</span>
      </div>
    </div>
  );
}

/* ---------------- 신호 / 링크 ---------------- */
function LinkPanel() {
  const [d, setD] = PS.useState(snapshot());
  PS.useEffect(() => {
    const id = setInterval(() => setD(snapshot()), 260);
    return () => clearInterval(id);
  }, []);
  const rssi = Math.max(-95, -52 - d.distHome * 0.06 - d.gust * 1.4);
  const q = Math.max(0, Math.min(1, (rssi + 95) / 43));
  return (
    <div className="link">
      <div className="lk-row">
        <span>제어 링크 RSSI</span>
        <b>{fmt(rssi, 0)} dBm</b>
      </div>
      <div className="bar"><i className={'bar-f' + (q < 0.35 ? ' bar-crit' : q < 0.6 ? ' bar-warn' : '')} style={{ width: (q * 100) + '%' }} /></div>
      <div className="lk-row">
        <span>영상 링크</span>
        <b>{q > 0.55 ? '1080p 30fps' : q > 0.3 ? '720p 30fps' : '480p 15fps'}</b>
      </div>
      <div className="bar"><i className={'bar-f' + (q < 0.35 ? ' bar-crit' : '')} style={{ width: (q * 100) + '%' }} /></div>
      <div className="lk-row">
        <span>지연</span>
        <b>{fmt(42 + (1 - q) * 160, 0)} ms</b>
      </div>
    </div>
  );
}

/* ---------------- 이력 차트 패널 ---------------- */
function ChartPanel() {
  const [d, setD] = PS.useState(snapshot());
  PS.useEffect(() => {
    const id = setInterval(() => setD(snapshot()), 200);
    return () => clearInterval(id);
  }, []);
  const U = window.SimUtil;
  return (
    <div className="chart">
      <div className="chart-head">
        <span>비행 이력 · 최근 90초</span>
        <div className="legend">
          <span className="lg lg-a">고도</span>
          <span className="lg lg-s">속도</span>
          <span className="lg lg-b">배터리</span>
        </div>
      </div>
      <div className="chart-cv"><HistoryChart /></div>
    </div>
  );
}

/* ---------------- 전원 + 링크 통합 ---------------- */
function PowerPanel() {
  return (
    <div className="power">
      <BatteryPanel />
      <div className="pwr-div" />
      <LinkPanel />
    </div>
  );
}

/* ---------------- 제어 스위치 ---------------- */
function Switch({ on, onClick, label, kbd }) {
  return (
    <button className={'sw' + (on ? ' on' : '')} onClick={onClick}>
      <span className="sw-l">{label}</span>
      {kbd && <span className="sw-k">{kbd}</span>}
      <span className="sw-d"><i /></span>
    </button>
  );
}

window.panelsFmt = fmt;

Object.assign(window, {
  Telemetry, Instruments, EventLog, MissionList, BatteryPanel, LinkPanel, PowerPanel,
  ChartPanel, Switch, fmt, snapshot
});
