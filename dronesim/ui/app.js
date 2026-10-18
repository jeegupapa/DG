/* 드론 임무 시뮬레이터 화면 로직 (pywebview 데스크톱 / 개발 서버 공용) */
(() => {
  "use strict";

  // ───────────────────────── API 브리지
  // 데스크톱(pywebview)에서는 window.pywebview.api, 개발 서버에서는 POST /api/<name>
  function devApi() {
    return new Proxy({}, {
      // "then"을 함수로 돌려주면 await가 thenable로 오인해 멈추므로 제외한다.
      get: (_, name) => (typeof name !== "string" || name === "then") ? undefined : (...args) =>
        fetch("/api/" + name, { method: "POST", body: JSON.stringify(args) }).then(r => r.json()),
    });
  }
  function getApi() {
    return new Promise(resolve => {
      if (window.pywebview && window.pywebview.api) return resolve(window.pywebview.api);
      let done = false;
      window.addEventListener("pywebviewready", () => { if (!done) { done = true; resolve(window.pywebview.api); } });
      setTimeout(() => { if (!done) { done = true; resolve(window.pywebview ? window.pywebview.api : devApi()); } }, 800);
    });
  }

  const $ = id => document.getElementById(id);
  const fmt = {
    m: v => v >= 1000 ? (v / 1000).toFixed(2) + " km" : Math.round(v) + " m",
    s: v => { const m = Math.floor(v / 60), s = Math.round(v % 60); return m + "분 " + String(s).padStart(2, "0") + "초"; },
    pct: v => Math.round(v * 100) + "%",
    mmss: v => { const m = Math.floor(v / 60), s = Math.round(v % 60); return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0"); },
    split: v => v >= 1000 ? { v: (v / 1000).toFixed(2), u: "km" } : { v: String(Math.round(v)), u: "m" },
    n1: v => (v == null ? "-" : Number(v).toFixed(1)),
    dir: d => { const names = ["북", "북동", "동", "남동", "남", "남서", "서", "북서"]; return names[Math.round(((d % 360) + 360) % 360 / 45) % 8]; },
  };
  const STATUS_KO = { ok: "양호", warn: "주의", fail: "불가", info: "참고" };

  // ───────────────────────── 상태
  const state = {
    api: null,
    desktop: false,
    profiles: [],
    waypoints: [],       // {lat, lon, alt_m, hover_s}
    markers: [],
    result: null,
  };

  // ───────────────────────── 지도
  const map = L.map("map", { zoomControl: true }).setView([36.3504, 127.3845], 14);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  const routeLine = L.polyline([], { color: "#1f74d8", weight: 3 }).addTo(map);
  const rthLine = L.polyline([], { color: "#1f74d8", weight: 2, opacity: 0.6, dashArray: "6 6" }).addTo(map);
  const rangeCircle = L.circle([0, 0], { radius: 0, color: "#5d6f7e", weight: 1, fill: false, dashArray: "4 4" });

  map.on("click", e => {
    addWaypoint(e.latlng.lat, e.latlng.lng, Number($("defaultAlt").value) || 50, 0);
  });

  function addWaypoint(lat, lon, alt, hover) {
    state.waypoints.push({ lat, lon, alt_m: alt, hover_s: hover });
    redraw();
  }

  function redraw() {
    state.markers.forEach(m => m.remove());
    state.markers = [];
    state.waypoints.forEach((wp, i) => {
      const icon = L.divIcon({ className: "", html: `<div class="wp-marker ${i === 0 ? "home" : ""}">${i + 1}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
      const mk = L.marker([wp.lat, wp.lon], { icon, draggable: true }).addTo(map);
      mk.on("drag", ev => { const p = ev.target.getLatLng(); wp.lat = p.lat; wp.lon = p.lng; drawLines(); });
      mk.on("dragend", () => renderWpTable());
      mk.bindTooltip(`WP${i + 1}${i === 0 ? " (홈)" : ""} · ${wp.alt_m} m`, { direction: "top", offset: [0, -12] });
      state.markers.push(mk);
    });
    drawLines();
    renderWpTable();
  }

  function drawLines() {
    const pts = state.waypoints.map(w => [w.lat, w.lon]);
    routeLine.setLatLngs(pts);
    if ($("rth").checked && pts.length > 1) rthLine.setLatLngs([pts[pts.length - 1], pts[0]]);
    else rthLine.setLatLngs([]);
    if (pts.length && $("vlos").checked) {
      rangeCircle.setLatLng(pts[0]).setRadius(500);
      if (!map.hasLayer(rangeCircle)) rangeCircle.addTo(map);
    } else if (map.hasLayer(rangeCircle)) {
      rangeCircle.remove();
    }
  }

  function renderWpTable() {
    const tb = $("wpTable").querySelector("tbody");
    tb.innerHTML = "";
    $("wpEmpty").classList.toggle("hidden", state.waypoints.length > 0);
    const tw = $("tagWp");
    tw.textContent = state.waypoints.length + " 지점";
    tw.className = "ph-tag" + (state.waypoints.length ? "" : " idle");
    state.waypoints.forEach((wp, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${i + 1}${i === 0 ? "<span class='muted'> 홈</span>" : ""}</td>
        <td>${wp.lat.toFixed(5)}</td><td>${wp.lon.toFixed(5)}</td>
        <td><input type="number" min="5" max="500" step="5" value="${wp.alt_m}" data-i="${i}" data-k="alt_m"></td>
        <td><input type="number" min="0" max="3600" step="10" value="${wp.hover_s}" data-i="${i}" data-k="hover_s"></td>
        <td><button class="del" title="삭제" data-del="${i}">✕</button></td>`;
      tb.appendChild(tr);
    });
    tb.querySelectorAll("input").forEach(inp => inp.addEventListener("change", ev => {
      const i = Number(ev.target.dataset.i), k = ev.target.dataset.k;
      state.waypoints[i][k] = Number(ev.target.value) || 0;
      redraw();
    }));
    tb.querySelectorAll("button[data-del]").forEach(b => b.addEventListener("click", ev => {
      state.waypoints.splice(Number(ev.target.dataset.del), 1);
      redraw();
    }));
  }

  // ───────────────────────── 임무 입력 수집
  function collectMission() {
    return {
      name: $("name").value.trim() || "임무",
      date: $("date").value,
      time: $("time").value || "09:00",
      profile_id: $("profile").value,
      mission_type: $("missionType").value,
      payload_kg: Number($("payload").value) || 0,
      return_to_home: $("rth").checked,
      vlos: $("vlos").checked,
      night_approved: $("nightApproved").checked,
      gps_risk: $("gpsRisk").checked,
      waypoints: state.waypoints.map(w => ({ lat: w.lat, lon: w.lon, alt_m: w.alt_m, hover_s: w.hover_s })),
    };
  }

  function applyMission(m) {
    $("name").value = m.name || "임무";
    if (m.date) $("date").value = m.date;
    $("time").value = m.time || "09:00";
    if (m.profile_id) $("profile").value = m.profile_id;
    $("missionType").value = m.mission_type || "촬영";
    $("payload").value = m.payload_kg || 0;
    $("rth").checked = m.return_to_home !== false;
    $("vlos").checked = m.vlos !== false;
    $("nightApproved").checked = !!m.night_approved;
    $("gpsRisk").checked = !!m.gps_risk;
    state.waypoints = (m.waypoints || []).map(w => ({ lat: w.lat, lon: w.lon, alt_m: w.alt_m ?? 50, hover_s: w.hover_s ?? 0 }));
    redraw();
    if (state.waypoints.length) map.fitBounds(routeLine.getBounds().pad(0.3));
    updateProfileInfo();
    updateTopbar();
  }

  function updateProfileInfo() {
    const p = state.profiles.find(x => x.id === $("profile").value);
    if (!p) return;
    $("profileInfo").textContent =
      `순항 ${p.cruise_speed_ms} m/s · 풍속한계 ${p.max_wind_ms} m/s · 배터리 ${p.battery_wh} Wh(가용 ${Math.round(p.usable_wh)} Wh) · 호버 체공 약 ${p.hover_endurance_min}분 · ${p.rain_ok ? "방수" : "비방수"} · ${p.notes}`;
  }

  function setStatus(msg, isErr) {
    const el = $("status");
    el.textContent = msg || "";
    el.classList.toggle("err", !!isErr);
  }

  // ───────────────────────── 실행
  async function runSimulation() {
    const mission = collectMission();
    if (!mission.waypoints.length) return setStatus("지도에서 웨이포인트를 먼저 입력하세요.", true);
    if (!mission.date) return setStatus("날짜를 입력하세요.", true);
    const btn = $("btnRun");
    btn.disabled = true;
    const source = $("weatherSource").value || "auto";
    setStatus(`기상 자료(${SOURCE_REQ_KO[source] || source})를 가져와 시뮬레이션 중…`);
    setLamp("lampWx", "idle", "기상 조회 중");
    try {
      const res = await state.api.simulate(mission, Number($("nRuns").value), source);
      if (res.error) { setStatus(res.error, true); setLamp("lampWx", "crit", "기상 오류"); if (res.trace) console.error(res.trace); return; }
      state.result = res;
      renderResult(res);
      if (!$("view3d").classList.contains("hidden")) show3d(true);   // 3D 뷰가 열려 있으면 새 결과로 다시 재생
      const ws = res.weather_source || {};
      const fallback = ws.requested === "auto" && ws.used !== "kma" && ws.note && ws.note.includes("Open-Meteo");
      setStatus(`완료 · ${sourceLabel(res)} 자료 (${res.weather.timezone})${fallback ? " · 기상청 미사용: " + shortNote(ws.note) : ""}`);
      setLamp("lampWx", fallback ? "warn" : "ok", fallback ? "Open-Meteo 폴백" : shortSource(res));
    } catch (e) {
      setStatus("실행 오류: " + e, true);
      setLamp("lampWx", "crit", "기상 오류");
    } finally {
      btn.disabled = false;
    }
  }

  // ───────────────────────── 기상 소스 표시
  const SOURCE_REQ_KO = { auto: "자동", kma: "기상청", "open-meteo": "Open-Meteo" };
  const SOURCE_USED_KO = { kma: "기상청 단기예보", forecast: "Open-Meteo 예보", archive: "Open-Meteo 과거 재분석" };
  function sourceLabel(r) {
    return (r.weather_source && r.weather_source.label) || SOURCE_USED_KO[r.weather.source] || r.weather.source;
  }
  function shortNote(note) {
    // "기상청 실패 → Open-Meteo 폴백: 사유" / "기상청 인증키 없음 → Open-Meteo 사용" 에서 사유만 짧게
    const m = /폴백: (.+)$/.exec(note || "");
    return m ? m[1] : (note || "").includes("인증키 없음") ? "인증키 없음" : (note || "");
  }
  /** 상단바 램프용 짧은 소스 이름 */
  function shortSource(r) {
    const used = (r.weather_source && r.weather_source.used) || r.weather.source;
    return used === "kma" ? "기상청" : "Open-Meteo";
  }

  // ───────────────────────── 상단바 (임무 값 쌍 · 상태 램프)
  function updateTopbar() {
    $("tbName").textContent = $("name").value.trim() || "-";
    $("tbWhen").textContent = ($("date").value || "-") + " " + ($("time").value || "");
    const p = $("profile"), opt = p.options[p.selectedIndex];
    $("tbProfile").textContent = opt ? opt.textContent : "-";
    $("tbSource").textContent = SOURCE_REQ_KO[$("weatherSource").value] || $("weatherSource").value;
  }
  /** tone: ok | warn | crit | idle */
  function setLamp(id, tone, text) {
    const el = $(id);
    el.className = "lamp lamp-" + tone;
    el.innerHTML = "<i></i>";
    el.appendChild(document.createTextNode(text));
  }
  /** 판정 상태 → 칩/스트립 톤 클래스 (fail 은 crit 으로) */
  function tone(status) { return status === "fail" ? "crit" : status === "warn" ? "warn" : "ok"; }

  // ───────────────────────── 결과 표시
  function renderResult(r) {
    $("resultEmpty").classList.add("hidden");
    $("result").classList.remove("hidden");
    const n = r.nominal, mc = r.monte_carlo;

    const badge = $("verdictBadge");
    badge.textContent = r.verdict;
    badge.className = "badge " + r.overall;
    $("probability").textContent = Math.round(mc.success_probability * 100);
    $("verdictSub").textContent = `${n.start_time.replace("T", " ")} 출발 · ${mc.runs}회 반복 · 배터리 사용 중앙값 ${fmt.pct(mc.battery_used_p50)}, 90% 구간 ${fmt.pct(mc.battery_used_p90)}`;
    $("tagVerdict").textContent = r.verdict;
    $("tagVerdict").className = "ph-tag " + tone(r.overall);
    $("resultNote").textContent = `${n.start_time.replace("T", " ")} 출발 · ${mc.runs}회`;
    $("btnReport").classList.remove("hidden");

    // 텔레메트리 스트립: 값 + 단위 + 서브라인, 판정 톤
    const byKey = {};
    n.checks.forEach(c => { byKey[c.key] = c; });
    const setTone = (id, c) => { $(id).className = "ro" + (c && c.status !== "ok" && c.status !== "info" ? " ro-" + tone(c.status) : ""); };
    $("kTime").textContent = fmt.mmss(n.total_time_s);
    $("kTimeSub").textContent = `10~90% ${fmt.mmss(mc.time_p10_s)} ~ ${fmt.mmss(mc.time_p90_s)}`;
    setTone("roTime", null);
    const dist = fmt.split(n.total_distance_m);
    $("kDist").textContent = dist.v; $("kDistUnit").textContent = dist.u;
    $("kDistSub").textContent = `최대 고도 ${n.max_alt_m} m · ${r.mission.waypoints.length} 지점`;
    setTone("roDist", byKey.altitude);
    $("kBatt").textContent = Math.round(n.battery_used_frac * 100);
    $("kBattSub").textContent = `${Math.round(n.total_energy_wh)} / 가용 ${Math.round(n.usable_wh)} Wh`;
    setTone("roBatt", byKey.battery);
    const rng = fmt.split(n.max_dist_home_m);
    $("kRange").textContent = rng.v; $("kRangeUnit").textContent = rng.u;
    $("kRangeSub").textContent = byKey.range ? `기준 ${byKey.range.limit}` : "";
    setTone("roRange", byKey.range);

    // 판정
    const cb = $("checksBody");
    cb.innerHTML = "";
    n.checks.forEach(c => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td><span class="dot ${c.status}"></span></td><td>${c.title}</td><td>${c.value}</td><td class="muted">${c.limit}</td><td class="st-${c.status}">${STATUS_KO[c.status]} · ${c.message}</td>`;
      cb.appendChild(tr);
    });
    const nFail = n.checks.filter(c => c.status === "fail").length, nWarn = n.checks.filter(c => c.status === "warn").length;
    $("tagChecks").textContent = nFail || nWarn ? [nFail ? `불가 ${nFail}` : "", nWarn ? `주의 ${nWarn}` : ""].filter(Boolean).join(" · ") : "모두 양호";
    $("tagChecks").className = "ph-tag " + (nFail ? "crit" : nWarn ? "warn" : "ok");
    const fr = $("failReasons");
    fr.innerHTML = "";
    if (!mc.failure_reasons.length) fr.innerHTML = "<li class='muted'>반복 시뮬레이션에서 실패 없음</li>";
    mc.failure_reasons.forEach(x => {
      const li = document.createElement("li");
      li.innerHTML = `${x.reason} <b>${Math.round(x.share * 100)}%</b><span class="bar" style="width:${Math.max(4, x.share * 120)}px"></span>`;
      fr.appendChild(li);
    });

    // 구간
    const sb = $("segBody");
    sb.innerHTML = "";
    n.segments.forEach(s => {
      const tr = document.createElement("tr");
      const wind = s.kind === "leg" || s.kind === "return"
        ? `${fmt.n1(s.wind_speed_ms)} m/s ${fmt.dir(s.wind_dir_deg)} (${s.along_ms >= 0 ? "뒷" : "맞"}바람 ${fmt.n1(Math.abs(s.along_ms))}, 측풍 ${fmt.n1(Math.abs(s.cross_ms))})`
        : "-";
      tr.innerHTML = `<td>${s.label}</td><td>${s.distance_m ? fmt.m(s.distance_m) : "-"}</td><td>${fmt.s(s.time_s)}</td>
        <td>${s.ground_speed_ms != null ? fmt.n1(s.ground_speed_ms) + " m/s" : "-"}</td><td>${wind}</td><td>${fmt.n1(s.energy_wh)} Wh</td>
        <td class="st-${s.status}">${s.status === "ok" ? "" : (STATUS_KO[s.status] + (s.note ? " · " + s.note : ""))}</td>`;
      sb.appendChild(tr);
    });
    $("segStats").textContent = `비행시간 10~90% 구간 ${fmt.s(mc.time_p10_s)} ~ ${fmt.s(mc.time_p90_s)} · 가용 배터리 ${Math.round(n.usable_wh)} Wh 중 ${Math.round(n.total_energy_wh)} Wh 소요`;
    const segWorst = n.segments.some(s => s.status === "fail") ? "fail" : n.segments.some(s => s.status === "warn") ? "warn" : "ok";
    $("tagSegments").textContent = `${n.segments.length} 구간 · ${fmt.mmss(n.total_time_s)}`;
    $("tagSegments").className = "ph-tag " + tone(segWorst);

    // 기상
    const w = r.weather_at_start;
    $("wxSummary").innerHTML = [
      ["기온", fmt.n1(w.temp_c) + " °C"],
      ["바람 10 m", `${fmt.n1(w.wind_10m[0])} m/s ${fmt.dir(w.wind_10m[1])}`],
      ["바람 비행고도", `${fmt.n1(w.wind_alt[0])} m/s ${fmt.dir(w.wind_alt[1])}`],
      ["돌풍", fmt.n1(w.gust_ms) + " m/s"],
      ["강수", `${fmt.n1(w.precip_mm)} mm${w.precip_prob != null ? " / " + Math.round(w.precip_prob) + "%" : ""}`],
      ["시정 / 구름", `${w.visibility_m != null ? (w.visibility_m / 1000).toFixed(1) + " km" : "-"} / ${w.cloud_cover != null ? Math.round(w.cloud_cover) + "%" : "-"}`],
    ].map(([k, v]) => `<div class="kpi"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("");
    const wb = $("wxBody");
    wb.innerHTML = "";
    const startH = Number(n.start_time.slice(11, 13)), endH = Number(n.end_time.slice(11, 13));
    r.weather.hours.forEach((h, i) => {
      const tr = document.createElement("tr");
      if (i >= startH && i <= endH) tr.className = "hl";
      const w10 = h.wind_levels["10"], wAlt = windAt(h, n.max_alt_m);
      tr.innerHTML = `<td>${h.time.slice(11, 16)}</td><td>${fmt.n1(h.temp_c)}</td>
        <td>${w10 ? fmt.n1(w10[0]) + " " + fmt.dir(w10[1]) : "-"}</td><td>${wAlt ? fmt.n1(wAlt[0]) + " " + fmt.dir(wAlt[1]) : "-"}</td>
        <td>${fmt.n1(h.gust_ms)}</td><td>${fmt.n1(h.precip_mm)}${h.precip_prob != null ? " / " + Math.round(h.precip_prob) + "%" : ""}</td>
        <td>${h.visibility_m != null ? (h.visibility_m / 1000).toFixed(0) : "-"}</td>`;
      wb.appendChild(tr);
    });
    $("wxSource").textContent = `${sourceLabel(r)} · 지점 ${r.weather.latitude.toFixed(3)}, ${r.weather.longitude.toFixed(3)} · 일출 ${(r.weather.sunrise || "").slice(11, 16)} 일몰 ${(r.weather.sunset || "").slice(11, 16)} · 단위 m/s, °C, mm, km`
      + (r.weather.note ? `\n${r.weather.note}` : "");

    const wsrc = r.weather_source || {};
    const wxFallback = wsrc.requested === "auto" && wsrc.used !== "kma" && wsrc.note && wsrc.note.includes("Open-Meteo");
    $("tagWeather").textContent = sourceLabel(r);
    $("tagWeather").className = "ph-tag " + (wxFallback ? "warn" : "ok");
    $("wxNote").textContent = `${r.weather.latitude.toFixed(3)}, ${r.weather.longitude.toFixed(3)} · ${r.weather.timezone}`;

    // 하드웨어
    const groups = {};
    r.hardware.forEach(h => { (groups[h.category] ||= []).push(h); });
    $("hwList").innerHTML = Object.entries(groups).map(([cat, items]) =>
      `<div class="hwcat"><h4>${cat}</h4>${items.map(h =>
        `<div class="hwitem"><span class="n">${h.name}</span>${h.spec ? `<span class="s">${h.spec}</span>` : ""}${h.trigger ? `<span class="tag">조건: ${TRIGGER_KO[h.trigger] || h.trigger}</span>` : ""}<span class="r">${h.reason}</span></div>`).join("")}</div>`
    ).join("");
    $("tagHardware").textContent = `${r.hardware.length} 품목`;
    $("tagHardware").className = "ph-tag";

    drawLines();
  }

  const TRIGGER_KO = {
    bvlos: "가시권 밖", night: "야간", high_altitude: "고도 150 m 초과", long_duration: "체공시간 초과",
    camera_payload: "촬영·측량", survey_payload: "측량", delivery_payload: "운송", patrol_payload: "순찰",
    gps_risk: "GPS 취약", strong_wind: "강풍", rain: "강수", cold: "저온", heavy_payload: "고중량",
  };

  function windAt(h, alt) {
    const lv = Object.keys(h.wind_levels).map(Number).sort((a, b) => a - b);
    if (!lv.length) return null;
    if (alt <= lv[0]) return h.wind_levels[String(lv[0])];
    if (alt >= lv[lv.length - 1]) return h.wind_levels[String(lv[lv.length - 1])];
    for (let i = 0; i < lv.length - 1; i++) {
      if (alt >= lv[i] && alt <= lv[i + 1]) {
        const a = h.wind_levels[String(lv[i])], b = h.wind_levels[String(lv[i + 1])], t = (alt - lv[i]) / (lv[i + 1] - lv[i]);
        return [a[0] + (b[0] - a[0]) * t, b[1]];
      }
    }
    return null;
  }

  // ───────────────────────── 보고서
  function buildReport(r) {
    const n = r.nominal, mc = r.monte_carlo, m = r.mission;
    const L = [];
    L.push(`드론 임무 사전 평가 보고서`, `생성: ${new Date().toLocaleString("ko-KR")}`, ``);
    L.push(`[임무] ${m.name} · ${m.date} ${m.time} 출발 · ${r.profile.name} · ${m.mission_type} · 페이로드 ${m.payload_kg} kg`);
    L.push(`웨이포인트 ${m.waypoints.length}개 · 총 거리 ${fmt.m(n.total_distance_m)} · 최대 이격 ${fmt.m(n.max_dist_home_m)} · 최대 고도 ${n.max_alt_m} m`, ``);
    L.push(`[판정] ${r.verdict} · 성공 확률 ${Math.round(mc.success_probability * 100)}% (${mc.runs}회)`);
    L.push(`비행시간 ${fmt.s(n.total_time_s)} · 배터리 ${Math.round(n.total_energy_wh)} / 가용 ${Math.round(n.usable_wh)} Wh (${fmt.pct(n.battery_used_frac)})`, ``);
    L.push(`[항목별 판정]`);
    n.checks.forEach(c => L.push(`  ${STATUS_KO[c.status].padEnd(2)} ${c.title}: ${c.value} (기준 ${c.limit}) - ${c.message}`));
    if (mc.failure_reasons.length) { L.push(``, `[실패 원인 분포]`); mc.failure_reasons.forEach(x => L.push(`  ${x.reason}: ${Math.round(x.share * 100)}%`)); }
    L.push(``, `[구간]`);
    n.segments.forEach(s => L.push(`  ${s.label}: ${s.distance_m ? fmt.m(s.distance_m) : "-"}, ${fmt.s(s.time_s)}, ${fmt.n1(s.energy_wh)} Wh${s.note ? " - " + s.note : ""}`));
    const w = r.weather_at_start;
    L.push(``, `[출발 시 기상] 기온 ${fmt.n1(w.temp_c)} °C · 바람 10 m ${fmt.n1(w.wind_10m[0])} m/s ${fmt.dir(w.wind_10m[1])} · 비행고도 ${fmt.n1(w.wind_alt[0])} m/s · 돌풍 ${fmt.n1(w.gust_ms)} · 강수 ${fmt.n1(w.precip_mm)} mm · 자료 ${sourceLabel(r)}`);
    if (r.weather.note) L.push(`  (${r.weather.note})`);
    L.push(``, `[필요 하드웨어]`);
    r.hardware.forEach(h => L.push(`  [${h.category}] ${h.name}${h.spec ? " (" + h.spec + ")" : ""} - ${h.reason}`));
    L.push(``, `※ 기상은 ${sourceLabel(r)} 자료 기반 추정이며 국지 바람·공역 승인 여부는 별도 확인이 필요합니다.`);
    return L.join("\n");
  }

  // ───────────────────────── 파일 (데스크톱: 대화상자 / 브라우저: 다운로드)
  function download(filename, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  async function exportMission(fmtName) {
    const mission = collectMission();
    if (!mission.waypoints.length) return setStatus("웨이포인트가 없습니다.", true);
    if (state.desktop) {
      const res = await state.api.export_mission(mission, fmtName);
      if (res.error) return setStatus(res.error, true);
      if (!res.cancelled) setStatus("저장: " + res.path);
    } else {
      const res = await state.api.export_mission_text(mission, fmtName);
      if (res.error) return setStatus(res.error, true);
      download(res.filename, res.text);
      setStatus("다운로드: " + res.filename);
    }
  }
  async function loadMission() {
    if (state.desktop) {
      const res = await state.api.load_mission();
      if (res.error) return setStatus(res.error, true);
      if (!res.cancelled) { applyMission(res.mission); setStatus("불러옴: " + res.path); }
    } else {
      const inp = document.createElement("input");
      inp.type = "file"; inp.accept = ".json";
      inp.onchange = async () => {
        const f = inp.files[0]; if (!f) return;
        try { applyMission(JSON.parse(await f.text())); setStatus("불러옴: " + f.name); }
        catch (e) { setStatus("임무 파일을 읽을 수 없습니다: " + e, true); }
      };
      inp.click();
    }
  }
  async function saveReport() {
    if (!state.result) return;
    const text = buildReport(state.result);
    const name = `${state.result.mission.name}_${state.result.mission.date}_평가보고서.txt`;
    if (state.desktop) {
      const res = await state.api.save_report(text, name);
      if (res.error) return setStatus(res.error, true);
      if (!res.cancelled) setStatus("보고서 저장: " + res.path);
    } else {
      download(name, text);
    }
  }

  // ───────────────────────── 설정 (기상 소스 기본값·기상청 인증키)
  function setKmaStatus(msg, cls) {
    const el = $("kmaStatus");
    el.textContent = msg || "";
    el.className = "status" + (cls ? " " + cls : "");
  }
  function applySettings(s) {
    if (s.weather_source) $("weatherSource").value = s.weather_source;
    const tag = $("kmaKeyState");
    tag.textContent = s.kma_key_set ? (s.kma_key_origin === "env" ? "환경변수 키 사용 중" : "키 저장됨") : "키 없음";
    tag.className = "ph-tag" + (s.kma_key_set ? " ok" : " idle");
    setLamp("lampKma", s.kma_key_set ? "ok" : "idle", s.kma_key_set ? "기상청 키" : "기상청 키 없음");
    updateTopbar();
    $("configPath").textContent = "설정 파일: " + (s.config_path || "");
    $("autoUpdate").checked = s.auto_update !== false;
    $("kmaKey").disabled = s.kma_key_origin === "env";
    if (s.kma_key_origin === "env") $("kmaKey").placeholder = "환경변수 KMA_SERVICE_KEY 가 우선 적용됩니다";
  }
  async function loadSettings() {
    try { applySettings(await state.api.get_settings()); }
    catch (e) { setKmaStatus("설정을 읽을 수 없습니다: " + e, "err"); }
  }
  async function saveKmaKey() {
    const key = $("kmaKey").value.trim();
    if (!key) return setKmaStatus("인증키를 입력하세요.", "err");
    const res = await state.api.save_settings({ kma_service_key: key });
    if (res.error) return setKmaStatus(res.error, "err");
    $("kmaKey").value = "";
    applySettings(res);
    setKmaStatus("인증키를 저장했습니다. 기상 소스 '자동' 또는 '기상청'으로 실행하면 기상청 자료를 사용합니다.", "ok");
  }
  async function clearKmaKey() {
    const res = await state.api.save_settings({ kma_service_key: "" });
    if (res.error) return setKmaStatus(res.error, "err");
    $("kmaKey").value = "";
    applySettings(res);
    setKmaStatus("저장된 인증키를 삭제했습니다.", "");
  }
  async function checkKmaKey() {
    const key = $("kmaKey").value.trim() || null;
    setKmaStatus("기상청 API 연결 확인 중…", "");
    $("btnKmaCheck").disabled = true;
    try {
      const res = await state.api.check_kma_key(key);
      setKmaStatus((res.ok ? "✓ " : "✕ ") + res.message, res.ok ? "ok" : "err");
    } catch (e) {
      setKmaStatus("확인 실패: " + e, "err");
    } finally {
      $("btnKmaCheck").disabled = false;
    }
  }

  // ───────────────────────── 초기화
  async function init() {
    state.api = await getApi();
    const info = await state.api.app_info();
    state.desktop = !!info.desktop;
    $("appVersion").textContent = "v" + info.version + (state.desktop ? "" : " · dev");
    $("date").value = info.today;

    state.profiles = await state.api.get_profiles();
    const sel = $("profile");
    sel.innerHTML = state.profiles.map(p => `<option value="${p.id}">${p.name}</option>`).join("");
    sel.addEventListener("change", updateProfileInfo);
    updateProfileInfo();

    $("btnRun").addEventListener("click", runSimulation);
    $("btnClear").addEventListener("click", () => { state.waypoints = []; redraw(); });
    $("btnLoad").addEventListener("click", loadMission);
    $("btnSaveJson").addEventListener("click", () => exportMission("json"));
    $("btnPlan").addEventListener("click", () => exportMission("plan"));
    $("btnWaypoints").addEventListener("click", () => exportMission("waypoints"));
    $("btnReport").addEventListener("click", saveReport);
    setupView3D();
    $("rth").addEventListener("change", drawLines);
    $("vlos").addEventListener("change", drawLines);
    ["name", "date", "time", "profile", "weatherSource"].forEach(id => {
      $(id).addEventListener("input", updateTopbar);
      $(id).addEventListener("change", updateTopbar);
    });
    updateTopbar();
    await loadSettings();
    $("weatherSource").addEventListener("change", async () => {
      const res = await state.api.save_settings({ weather_source: $("weatherSource").value });
      if (res.error) setStatus(res.error, true);
    });
    $("btnKmaSave").addEventListener("click", saveKmaKey);
    $("btnKmaCheck").addEventListener("click", checkKmaKey);
    $("btnKmaClear").addEventListener("click", clearKmaKey);
    $("kmaKey").addEventListener("keydown", ev => { if (ev.key === "Enter") saveKmaKey(); });
    setupUpdater();
    document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach(x => x.classList.toggle("active", x === b));
      document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.id === "tab-" + b.dataset.tab));
    }));
    renderWpTable();
  }

  // ───────────────────────── 자동 업데이트
  const UPDATE_STATE_KO = { idle: "", checking: "확인 중", none: "최신", available: "새 버전", downloading: "다운로드 중",
                            ready: "준비됨", error: "오류", disabled: "꺼짐" };
  let updateTimer = null, updateDismissed = false;

  function renderUpdate(st) {
    const tag = $("updateState");
    tag.textContent = UPDATE_STATE_KO[st.state] ?? st.state;   // idle 은 빈 칩(숨김)
    const updTone = (st.state === "ready" || st.state === "none") ? "ok" : st.state === "error" ? "crit"
      : (st.state === "available" || st.state === "downloading") ? "warn" : "idle";
    tag.className = "ph-tag " + updTone;
    const LAMP_KO = { none: "최신", ready: "업데이트 준비", available: "새 버전", downloading: "다운로드 중",
                      checking: "업데이트 확인 중", error: "업데이트 오류", disabled: "업데이트 꺼짐" };
    setLamp("lampUpd", updTone, LAMP_KO[st.state] || "업데이트");
    const v = st.latest ? "v" + st.latest.version : "";
    let text = st.message || "";
    if (st.state === "downloading") text += ` ${Math.round((st.progress || 0) * 100)}%`;
    if (st.state === "none" && !text) text = `최신 버전입니다 (v${st.current}).`;
    $("updateStatus").textContent = text;
    $("updateStatus").classList.toggle("err", st.state === "error");
    $("btnUpdateApply").disabled = !st.can_apply;
    $("btnUpdateCheck").disabled = st.state === "checking" || st.state === "downloading";

    const banner = $("updateBanner");
    if (st.state === "ready" && st.can_apply && !updateDismissed) {
      banner.innerHTML = `<span>새 버전 <b>${v}</b> 이 준비되었습니다. 지금 적용하면 프로그램이 다시 시작됩니다.</span>` +
        `<button id="bannerApply" class="small primary">지금 적용</button><button id="bannerLater" class="small ghost">나중에</button>`;
      banner.classList.remove("hidden");
      $("bannerApply").addEventListener("click", applyUpdate);
      $("bannerLater").addEventListener("click", () => { updateDismissed = true; banner.classList.add("hidden"); });
    } else if (st.state === "downloading" && !updateDismissed) {
      banner.innerHTML = `<span>새 버전 ${v} 다운로드 중… ${Math.round((st.progress || 0) * 100)}%</span>`;
      banner.classList.remove("hidden");
    } else if (st.state !== "ready") {
      banner.classList.add("hidden");
    }
    // 진행 중이면 계속 관찰, 끝나면 멈춤
    const active = st.state === "checking" || st.state === "downloading";
    if (active && !updateTimer) updateTimer = setInterval(pollUpdate, 1500);
    if (!active && updateTimer) { clearInterval(updateTimer); updateTimer = null; }
  }
  async function pollUpdate() {
    try { renderUpdate(await state.api.update_status()); } catch (_) { /* 무시 */ }
  }
  async function applyUpdate() {
    $("btnUpdateApply").disabled = true;
    const res = await state.api.apply_update();
    if (res.error) { setStatus("업데이트 적용 실패: " + res.error, true); $("btnUpdateApply").disabled = false; return; }
    $("updateStatus").textContent = state.desktop ? "적용 중… 프로그램이 다시 시작됩니다." : "적용 명령을 실행했습니다.";
  }
  function setupUpdater() {
    $("btnUpdateCheck").addEventListener("click", async () => { renderUpdate(await state.api.check_update(true)); });
    $("btnUpdateApply").addEventListener("click", applyUpdate);
    $("autoUpdate").addEventListener("change", async () => {
      const res = await state.api.save_settings({ auto_update: $("autoUpdate").checked });
      if (res.error) setStatus(res.error, true);
    });
    pollUpdate();                    // 시작 시 백그라운드 확인이 돌고 있으면 상태를 받아온다
    setTimeout(pollUpdate, 4000);
  }

  // ───────────────────────── 3D 비행 재생 (flight3d.js)
  let flight = null;

  function show3d(on) {
    $("view3d").classList.toggle("hidden", !on);
    $("map").classList.toggle("hidden", on);
    $("btnView2d").classList.toggle("active", !on);
    $("btnView3d").classList.toggle("active", on);
    if (!on) {
      if (flight) { flight.pause(); updatePlayBtn(); }
      setTimeout(() => map.invalidateSize(), 50);
      return;
    }
    $("empty3d").classList.toggle("hidden", !!state.result);
    if (!state.result) return;
    if (typeof Flight3D === "undefined" || typeof maplibregl === "undefined") {
      setStatus("3D 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인하세요.", true);
      return;
    }
    if (!flight) {
      flight = new Flight3D($("map3d"));
      flight.onTick = onTick3d;
      flight.onFollowChange = f => { $("follow3d").checked = f; };
    }
    flight.init().then(() => {
      flight.resize();
      if (flight.result !== state.result) flight.load(state.result);
      flight.speed = currentSpeed();
      flight.setFollow($("follow3d").checked);
      flight.play();
      updatePlayBtn();
    }).catch(e => setStatus("3D 뷰 오류: " + e, true));
  }

  /** 재생 속도 세그먼트 컨트롤의 현재 값 */
  function currentSpeed() {
    const on = $("speed3d").querySelector("button.on");
    return Number(on ? on.dataset.speed : 5) || 5;
  }

  function updatePlayBtn() {
    $("btnPlay3d").textContent = (flight && flight.playing) ? "⏸ 일시정지" : "▶ 재생";
  }

  function onTick3d(s) {
    const seg = s.seg || {};
    const wind = (seg.kind === "leg" || seg.kind === "return")
      ? `${fmt.n1(seg.wind_speed_ms)} m/s ${fmt.dir(seg.wind_dir_deg)} (${seg.along_ms >= 0 ? "뒷" : "맞"}바람 ${fmt.n1(Math.abs(seg.along_ms))})`
      : "-";
    $("hud3d").innerHTML =
      `<div class="hudseg">${seg.label || ""}</div>` +
      `<div><span class="k">고도</span><span class="v">${s.alt.toFixed(0)}</span> m <span class="muted">(지면 위 ${s.agl.toFixed(0)} m)</span></div>` +
      `<div><span class="k">지상속도</span><span class="v">${s.groundSpeed.toFixed(1)}</span> m/s · <span class="k">방위</span><span class="v">${Math.round(s.heading)}</span>°</div>` +
      `<div><span class="k">배터리</span><span class="v">${Math.round(s.battery * 100)}</span>% 사용</div>` +
      `<div><span class="k">바람</span>${wind}</div>` +
      (s.danger ? `<div class="danger">⚠ 지형과 간격 5 m 미만 · 고도 확인 필요</div>` : "") +
      (s.done ? `<div class="muted">임무 종료</div>` : "");
    $("time3d").textContent = `${Flight3D.fmtTime(s.t)} / ${Flight3D.fmtTime(s.total)}`;
    if (document.activeElement !== $("seek3d")) $("seek3d").value = s.total > 0 ? Math.round(s.t / s.total * 1000) : 0;
    if (s.done) updatePlayBtn();
  }

  function setupView3D() {
    $("btnView2d").addEventListener("click", () => show3d(false));
    $("btnView3d").addEventListener("click", () => show3d(true));
    $("btnPlay3d").addEventListener("click", () => { if (!flight || !flight.track) return; flight.toggle(); updatePlayBtn(); });
    $("btnReset3d").addEventListener("click", () => { if (!flight || !flight.track) return; flight.seek(0); flight.play(); updatePlayBtn(); });
    $("speed3d").querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
      $("speed3d").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
      if (flight) flight.speed = currentSpeed();
    }));
    $("follow3d").addEventListener("change", () => { if (flight) flight.setFollow($("follow3d").checked); });
    $("seek3d").addEventListener("input", () => {
      if (!flight || !flight.track) return;
      flight.pause(); updatePlayBtn();
      flight.seek(Number($("seek3d").value) / 1000 * flight.track.total);
    });
  }

  init().catch(e => setStatus("초기화 실패: " + e, true));
})();
