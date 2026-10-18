/* ==========================================================================
   app.jsx — 드론 시뮬레이션 콘솔 레이아웃
   ========================================================================== */
const AS = { useRef, useEffect, useState, useCallback };

const ACCENT_D = {
  '#1f74d8': '#0f4c93', '#0f7b6c': '#08584d',
  '#7a4fd0': '#573399', '#b8791a': '#8a5810'
};

function useStickInput() {
  return AS.useCallback((axis, x, y) => {
    const s = window.DroneSim.state.stick;
    if (axis === 'left') { s.lx = x; s.ly = y; } else { s.rx = x; s.ry = y; }
  }, []);
}

function useKeyboard() {
  AS.useEffect(() => {
    const k = window.DroneSim.state.keys;
    const D = window.DroneSim;
    const dn = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      k[key] = true;
      if (key === ' ') e.preventDefault();
      if (key === 't') D.takeoff();
      if (key === 'm') D.auto();
      if (key === 'h') D.hold();
      if (key === 'r') D.rtl();
      if (key === 'l') D.land();
      if (key === 'p') D.state.running = !D.state.running;
      if (key === 'g') D.state.showGrid = !D.state.showGrid;
    };
    const up = (e) => { delete k[e.key.length === 1 ? e.key.toLowerCase() : e.key]; };
    window.addEventListener('keydown', dn);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', dn); window.removeEventListener('keyup', up); };
  }, []);
}

/* ---------- 상단바 ---------- */
function snapTop() {
  const d = window.DroneSim.state;
  return {
    mode: d.mode, flightTime: d.flightTime, battery: d.battery, distHome: d.distHome,
    x: d.x, z: d.z, sats: d.sats, armed: d.armed, t: d.t
  };
}
function TopBar() {
  const [d, setD] = AS.useState(snapTop());
  AS.useEffect(() => {
    const id = setInterval(() => setD(snapTop()), 160);
    return () => clearInterval(id);
  }, []);
  const U = window.SimUtil, f = window.panelsFmt;
  const link = d.distHome < 300;
  return (
    <div className="topbar">
      <div className="tb-brand">
        <div className="tb-mark">DS</div>
        <div>
          <div className="tb-name">드론 비행 시뮬레이터</div>
          <div className="tb-sub">FLIGHT CONSOLE · SIM</div>
        </div>
      </div>
      <div className="tb-stats">
        <div className="tb-stat"><span>비행 모드</span><b>{window.DroneSim.MODE_KR[d.mode]}</b></div>
        <div className="tb-stat"><span>비행 시간</span><b>{U.time(d.flightTime)}</b></div>
        <div className="tb-stat"><span>배터리</span><b>{f(d.battery, 0)} %</b></div>
        <div className="tb-stat"><span>홈 거리</span><b>{f(U.dist(d.distHome), 0)} {U.distU()}</b></div>
        <div className="tb-stat"><span>현재 좌표</span><b>{f(d.x, 0)}, {f(d.z, 0)}</b></div>
      </div>
      <div className="tb-lamps">
        <Lamp tone={d.armed ? 'ok' : 'idle'}>{d.armed ? 'ARM' : 'DISARM'}</Lamp>
        <Lamp tone={d.sats < 10 ? 'warn' : 'ok'}>{'GNSS ' + d.sats}</Lamp>
        <Lamp tone={link ? 'ok' : 'warn'}>{link ? '링크 양호' : '링크 약화'}</Lamp>
        <Lamp tone={d.battery < 15 ? 'crit' : d.battery < 30 ? 'warn' : 'ok'}>
          {'배터리 ' + f(d.battery, 0) + '%'}
        </Lamp>
      </div>
      <div className="tb-clock">{U.time(d.t)} <span style={{ color: 'var(--faint)' }}>SIM</span></div>
    </div>
  );
}

/* ---------- 비행 제어 ---------- */
function ctlSnap() {
  const d = window.DroneSim.state;
  return {
    running: d.running, showGrid: d.showGrid, showTrail: d.showTrail, showMarkers: d.showMarkers,
    showFence: d.showFence, camMode: d.camMode, simSpeed: d.simSpeed, zoom: d.zoom,
    targetAlt: d.targetAlt, mode: d.mode, armed: d.armed
  };
}
function Controls() {
  const [d, setD] = AS.useState(ctlSnap());
  AS.useEffect(() => {
    const id = setInterval(() => setD(ctlSnap()), 200);
    return () => clearInterval(id);
  }, []);
  const S = window.DroneSim.state, D = window.DroneSim;
  const onStick = useStickInput();
  const busy = d.mode === 'AUTO' || d.mode === 'RTL' || d.mode === 'TAKEOFF';
  return (
    <div className="controls">
      <div className="cg">
        <div className="sect">비행 명령</div>
        <div className="ctl-grid">
          <button className="btn" onClick={() => D.takeoff()}>이륙 <kbd>T</kbd></button>
          <button className={'btn' + (d.mode === 'AUTO' ? ' primary' : '')} onClick={() => D.auto()}>자동 임무 <kbd>M</kbd></button>
          <button className={'btn' + (d.mode === 'HOLD' ? ' primary' : '')} onClick={() => D.hold()}>호버 홀드 <kbd>H</kbd></button>
          <button className={'btn' + (d.mode === 'RTL' ? ' primary' : '')} onClick={() => D.rtl()}>귀환 <kbd>R</kbd></button>
          <button className={'btn' + (d.mode === 'LAND' ? ' primary' : '')} onClick={() => D.land()}>착륙 <kbd>L</kbd></button>
          <button className="btn danger" onClick={() => D.reset(true)}>초기화</button>
          <button className="btn ghost full" onClick={() => D.scenario()}>시나리오 재생 · 이륙 → 순항 → 호버 → 착륙</button>
        </div>
      </div>

      <div className="cg">
        <div className="sect">스틱 입력 <span className="sect-n">{busy ? '자동 비행 중 · 입력 시 수동 전환' : '수동 조종 가능'}</span></div>
        <div className="joys">
          <Joystick axis="left" label="좌 스틱" sub="스로틀 / 요" onChange={onStick} />
          <Joystick axis="right" label="우 스틱" sub="피치 / 롤" onChange={onStick} />
        </div>
        <div className="ctl-note">키보드 <b>W A S D</b> · <b>방향키</b> 로도 조종됩니다.</div>
      </div>

      <div className="cg">
        <div className="sect">시뮬레이션</div>
        <div className="seg">
          {[0.5, 1, 2, 4].map(v => (
            <button key={v} className={d.simSpeed === v ? 'on' : ''}
              onClick={() => { S.simSpeed = v; }}>{v}×</button>
          ))}
        </div>
        <div className="seg" style={{ marginTop: 4 }}>
          <button className={d.running ? 'on' : ''} onClick={() => { S.running = true; }}>재생</button>
          <button className={!d.running ? 'on' : ''} onClick={() => { S.running = false; }}>일시정지</button>
        </div>
        <div className="sect" style={{ paddingTop: 5 }}>지령값</div>
        <div className="bar-l"><span>목표 고도</span><b>{d.targetAlt} m</b></div>
        <input className="rng" type="range" min="10" max="120" step="5" value={d.targetAlt}
          onChange={e => { S.targetAlt = +e.target.value; }} />
        <div className="bar-l"><span>카메라 줌</span><b>{d.zoom.toFixed(1)}×</b></div>
        <input className="rng" type="range" min="1" max="4" step="0.1" value={d.zoom}
          onChange={e => { S.zoom = +e.target.value; }} />
      </div>

      <div className="cg">
        <div className="sect">표시 옵션</div>
        <div className="sw-grid">
          <Switch on={d.showGrid} label="좌표 그리드" kbd="G" onClick={() => { S.showGrid = !S.showGrid; }} />
          <Switch on={d.showTrail} label="비행 궤적" onClick={() => { S.showTrail = !S.showTrail; }} />
          <Switch on={d.showMarkers} label="웨이포인트" onClick={() => { S.showMarkers = !S.showMarkers; }} />
          <Switch on={d.showFence} label="지오펜스" onClick={() => { S.showFence = !S.showFence; }} />
        </div>
        <div className="sect" style={{ paddingTop: 5 }}>3D 시점</div>
        <div className="seg">
          {[['orbit', '궤도'], ['chase', '추적'], ['top', '탑다운']].map(([k, l]) => (
            <button key={k} className={d.camMode === k ? 'on' : ''}
              onClick={() => { S.camMode = k; }}>{l}</button>
          ))}
        </div>
        <button className="btn ghost" style={{ marginTop: 5 }}
          onClick={() => { try { localStorage.removeItem('ds.pip.cam'); localStorage.removeItem('ds.pip.map'); } catch (e) { } location.reload(); }}>
          PiP 위치 초기화
        </button>
      </div>
    </div>
  );
}

/* ---------- 앱 ---------- */
function App() {
  const [t, setTweak] = useTweaks(window.TWEAK_DEFAULTS);
  const [pipSize, setPipSize] = AS.useState('md');
  const [ui, setUi] = AS.useState(ctlSnap());
  AS.useEffect(() => {
    const id = setInterval(() => setUi(ctlSnap()), 240);
    return () => clearInterval(id);
  }, []);

  AS.useEffect(() => {
    const r = document.documentElement.style;
    r.setProperty('--accent', t.accent);
    r.setProperty('--accent-d', ACCENT_D[t.accent] || '#0f4c93');
    window.SimU.accent = t.accent;
  }, [t.accent]);
  AS.useEffect(() => { window.SimU.sys = t.units; }, [t.units]);
  AS.useEffect(() => { window.DroneSim.state.simSpeed = t.simSpeed; }, [t.simSpeed]);
  useKeyboard();

  const camPip = (
    <Pip key="campip" title="짐벌 카메라" size={pipSize} storageKey="ds.pip.cam"
      onCycleSize={() => setPipSize(s => s === 'sm' ? 'md' : s === 'md' ? 'lg' : 'sm')}>
      <ViewCam zoom={ui.zoom} />
    </Pip>
  );
  const mapPip = (
    <Pip key="mappip" title="2D 지도" size="sm" storageKey="ds.pip.map" onCycleSize={() => { }}>
      <MiniMap />
    </Pip>
  );
  const chartPanel = <div className="panel grow" style={{ minWidth: 250 }}><ChartPanel /></div>;

  const missionPanel = () => (
    <div className="panel mpanel">
      <PanelHead title="임무 경로" code="MISSION"
        right={<span className="ph-r">{ui.mode === 'AUTO' ? 'WP' + (window.DroneSim.state.missionIdx + 1) + ' 진행 중' : '대기'}</span>} />
      <MissionList />
    </div>
  );

  let grid;
  if (t.layout === 'console') {
    grid = (
      <div className="body" data-layout="console">
        <div className="panel grow">
          <PanelHead title="계기판" code="PFD" right={<span className="ph-r">자세 · 고도 · 속도</span>} />
          <Instruments />
        </div>
        <div className="panel grow">
          <PanelHead title="3D 지형 뷰" code="3D" right={
            <span className="ph-r">
              <span className="ph-tag">고도 {window.SimUtil.n(window.SimUtil.alt(window.DroneSim.state.alt), 0)} {window.SimUtil.altU()}</span>
              <span className="ph-tag ok">P {window.SimUtil.n(window.DroneSim.state.pitch, 0)}° / R {window.SimUtil.n(window.DroneSim.state.roll, 0)}°</span>
            </span>
          } />
          <div className="view">
            <View3D camMode={ui.camMode} />
            {t.showCamPip && camPip}
          </div>
        </div>
        <div className="col">
          {missionPanel()}
          <div className="panel grow">
            <PanelHead title="이벤트 로그" code="LOG" />
            <EventLog />
          </div>
        </div>
        <div className="span-all row">
          <div className="panel fixed grow-ctl"><Controls /></div>
          {chartPanel}
          <div className="panel fixed pw-cell">
            <PanelHead title="동력 / 링크" code="PWR" />
            <PowerPanel />
          </div>
        </div>
      </div>
    );
  } else if (t.layout === 'map') {
    grid = (
      <div className="body" data-layout="map">
        <div className="panel grow">
          <PanelHead title="2D 지도 뷰" code="MAP" right={
            <span className="ph-r">
              <span className="ph-tag">궤적 {window.DroneSim.state.trail.length} pt</span>
              <span className="ph-tag ok">지오펜스 {window.DroneSim.state.fence} m</span>
            </span>
          } />
          <div className="view">
            <ViewMap ppm0={1.5} />
            {t.showCamPip && camPip}
          </div>
        </div>
        <div className="col">
          {missionPanel()}
          <div className="panel fixed">
            <PanelHead title="동력 / 링크" code="PWR" />
            <PowerPanel />
          </div>
          <div className="panel grow">
            <PanelHead title="이벤트 로그" code="LOG" />
            <EventLog />
          </div>
        </div>        <div className="span-all row">
          <div className="panel fixed grow-ctl"><Controls /></div>
          {chartPanel}
        </div>
      </div>
    );
  } else if (t.layout === 'cam') {
    grid = (
      <div className="body" data-layout="cam">
        <div className="panel grow">
          <PanelHead title="짐벌 카메라 뷰" code="CAM · 1080P30" right={
            <span className="ph-r">
              <span className="ph-tag">줌 {ui.zoom.toFixed(1)}×</span>
              <span className="ph-tag">FOV {(78 / ui.zoom).toFixed(0)}°</span>
              <span className="ph-tag ok">짐벌 {window.SimUtil.n(window.DroneSim.state.gimbalPitch, 0)}°</span>
            </span>
          } />
          <div className="view" style={{ background: '#c9d4da' }}>
            <ViewCam zoom={ui.zoom} />
            {t.showMapPip && mapPip}
          </div>
        </div>
        <div className="col">
          <div className="panel fixed">
            <PanelHead title="계기판" code="PFD" />
            <Instruments />
          </div>
          {missionPanel()}
        </div>
        <div className="span-all row">
          <div className="panel fixed grow-ctl"><Controls /></div>
          {chartPanel}
        </div>
      </div>
    );
  } else {
    grid = (
      <div className="body" data-layout="split">
        <div className="col">
          {missionPanel()}
          <div className="panel grow">
            <PanelHead title="이벤트 로그" code="LOG" />
            <EventLog />
          </div>
        </div>
        <div className="panel grow">
          <PanelHead title="2D 지도 뷰" code="MAP" />
          <div className="view"><ViewMap ppm0={1.4} /></div>
        </div>
        <div className="panel grow">
          <PanelHead title="3D 지형 뷰" code="3D" />
          <div className="view"><View3D camMode={ui.camMode} /></div>
        </div>
        <div className="span-all row">
          <div className="panel fixed grow-ctl"><Controls /></div>
          {chartPanel}
        </div>
      </div>
    );
  }

  return (
    <div className="app" data-density={t.density}>
      <TopBar />
      <Telemetry />
      {grid}
      <TweaksPanel>
        <TweakSection label="레이아웃" />
        <TweakSelect label="배치" value={t.layout}
          options={[
            { value: 'console', label: '관제 콘솔 · 계기 + 3D' },
            { value: 'map', label: '지도 중심 · 경로 비행' },
            { value: 'cam', label: '카메라 중심 · 짐벌 시점' },
            { value: 'split', label: '분할 · 지도 + 3D 동시' }
          ]}
          onChange={v => setTweak('layout', v)} />
        <TweakRadio label="밀도" value={t.density} options={['compact', 'standard', 'roomy']}
          onChange={v => setTweak('density', v)} />
        <TweakSection label="표시" />
        <TweakRadio label="단위" value={t.units} options={['metric', 'imperial']}
          onChange={v => setTweak('units', v)} />
        <TweakToggle label="카메라 PiP" value={t.showCamPip} onChange={v => setTweak('showCamPip', v)} />
        <TweakToggle label="지도 PiP" value={t.showMapPip} onChange={v => setTweak('showMapPip', v)} />
        <TweakSection label="테마" />
        <TweakColor label="강조색" value={t.accent}
          options={['#1f74d8', '#0f7b6c', '#7a4fd0', '#b8791a']}
          onChange={v => setTweak('accent', v)} />
        <TweakSection label="시뮬레이션" />
        <TweakSlider label="시뮬 속도" value={t.simSpeed} min={0.25} max={4} step={0.25} unit="×"
          onChange={v => setTweak('simSpeed', v)} />
        <TweakButton label="시나리오 재생" onClick={() => window.DroneSim.scenario()} />
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
