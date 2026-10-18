/* ---- 하이브리드 틱커 --------------------------------------------------
   requestAnimationFrame 만 쓰면 백그라운드/비합성 iframe 에서 콜백이
   아예 오지 않아 시뮬레이션과 캔버스가 멈춘다. rAF 와 setInterval 을
   동시에 돌리고, 먼저 도착한 쪽이 진행시키도록 했다(양쪽 모두 호출돼도
   경과 시간 합은 같으므로 속도가 두 배가 되지 않는다).
   --------------------------------------------------------------------- */
(function () {
  var subs = [];
  var last = 0;
  function step(now) {
    if (!last) last = now;
    var dt = now - last;
    if (dt < 2) return;
    if (dt > 200) dt = 200;
    last = now;
    for (var i = 0; i < subs.length; i++) {
      try { subs[i](dt, now); } catch (e) { }
    }
  }
  function rafLoop() {
    requestAnimationFrame(rafLoop);
    step(performance.now());
  }
  requestAnimationFrame(rafLoop);
  /* 워치독. rAF 가 살아 있으면 last 가 계속 갱신되므로 절대 개입하지 않고,
     rAF 가 스로틀/중단된 환경에서만 대신 진행시킨다. dt 는 언제나 직전
     step 과의 실제 경과 시간이라 어느 쪽이 호출하든 속도가 변하지 않는다. */
  setInterval(function () {
    var n = performance.now();
    if (n - last > 60) step(n);
  }, 30);
  window.Tick = {
    add: function (fn) { subs.push(fn); return fn; },
    remove: function (fn) { var i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }
  };
})();

/* 단위 변환 + 숫자 포맷 + 미니 유틸 */
(function () {
  var S = { sys: 'metric', dense: 'standard', accent: '#1f74d8' };
  window.SimU = S;
  window.SimUtil = {
    spd: function (v) { return S.sys === 'metric' ? v * 3.6 : v * 2.236936; },
    spdU: function () { return S.sys === 'metric' ? 'km/h' : 'mph'; },
    alt: function (v) { return S.sys === 'metric' ? v : v * 3.28084; },
    altU: function () { return S.sys === 'metric' ? 'm' : 'ft'; },
    dist: function (v) { return S.sys === 'metric' ? v : v * 3.28084; },
    distU: function () { return S.sys === 'metric' ? 'm' : 'ft'; },
    n: function (v, d) { return v.toFixed(d === undefined ? 1 : d); },
    pad: function (v, n) { var s = String(v); while (s.length < n) s = '0' + s; return s; },
    time: function (t) {
      var m = Math.floor(t / 60), s = Math.floor(t % 60);
      return this.pad(m, 2) + ':' + this.pad(s, 2);
    },
    bearing: function (deg) {
      var d = ((deg % 360) + 360) % 360;
      var dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
      return dirs[Math.round(d / 45) % 8] + ' ' + d.toFixed(0).padStart(3, '0') + '\u00b0';
    }
  };
})();
