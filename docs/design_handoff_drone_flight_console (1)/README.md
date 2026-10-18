# Handoff: 드론 비행 시뮬레이터 콘솔 (Drone Flight Simulator Console)

## Overview

A single-screen **drone flight simulation & monitoring console**. It combines three simultaneous views of the same simulated aircraft — a 2D map, a 3D terrain view, and a gimbal camera view — with a live instrument cluster and a 10-metric telemetry strip. Every number on screen is derived from a real physics integration running at 60 Hz, not a mock value.

The user can:

- Fly the aircraft manually (two on-screen virtual joysticks, or keyboard WASD + arrow keys)
- Command it (takeoff / auto mission / hover hold / return-to-home / land / reset / scripted scenario)
- Watch attitude, altitude, speed, battery, GNSS and link quality update live
- Change camera view mode (orbit / chase / top-down), toggle map layers (grid, trail, waypoints, geofence), and change zoom
- Switch between **four whole-console layouts** without reloading
- Read a scrolling event log that records mode transitions, mission arrivals, and system warnings

The purpose of the design is to demonstrate a dense, information-rich, **light-theme industrial console** that stays legible at high data density — an alternative to the dark "mission control" cliché.

---

## About the Design Files

**The files in this bundle are design references created in HTML.** They are prototypes that show the intended look and behavior — they are **not production code to copy directly**.

The task is to **recreate these designs in the target codebase's existing environment** (React, Vue, Svelte, SwiftUI, Flutter, native, etc.) using that environment's established patterns, component library, state management, and styling approach. If no environment exists yet, choose the most appropriate framework for the project and implement the designs there.

Concrete notes for whoever implements this:

- The prototype uses **React 18 UMD + Babel-in-the-browser** purely so it runs as a single static file. **Do not ship that.** Use a real build step (Vite/Next/etc.) with JSX compiled ahead of time.
- The prototype uses **three `<canvas>`-based renderers written from scratch** (2D map raster, 3D perspective projection, gimbal camera view). These are self-contained and framework-agnostic — they can be lifted almost verbatim into any codebase, or replaced with a real mapping/3D library if the product needs real geography or real 3D models. See "Renderers" below.
- The prototype's state lives in a plain mutable singleton (`window.DroneSim.state`) that is read by canvas draw loops. In a real codebase, put the sim in a dedicated store/engine module (Zustand, Redux, Pinia, or a plain observable) and drive React re-renders from a throttled subscription — **do not** re-render at 60 Hz.

---

## Fidelity

**High-fidelity (hifi).** The prototype has final colors, typography, spacing, and interactions. Recreate the UI pixel-perfectly using the codebase's existing libraries and patterns.

Two caveats where the prototype is deliberately *not* pixel-final:

1. **The terrain is synthetic.** The heightfield is a sum of four sine/cosine terms (`terrainH` in `sim.js`) — it is a plausible-looking generated landscape, not real geography. If the product needs real terrain, swap in a DEM tile source; the color ramp and shading model documented below are the part worth keeping.
2. **The gimbal camera view renders the same synthetic terrain from a first-person camera**, not a real video feed. In production this region should hold a real video stream (`<video>` / WebRTC) with the HUD overlay drawn on top. The HUD is drawn in canvas today so the overlay math is self-contained — the HUD spec below is what matters.

---

## Screens / Views

There is **one screen** with **four interchangeable layout arrangements**. The top bar and telemetry strip are identical in all four; only the body grid changes.

### Shared chrome (all layouts)

#### A. Top bar (`TopBar`, `.topbar`)

- **Purpose**: aircraft identity + at-a-glance flight state + status lamps.
- **Layout**: single flex row, `align-items: center`, `gap: 14px`, `padding: 9px 10px`, `min-height: 52px`. Background `#ffffff`, `border-radius: 7px`, shadow `0 1px 2px rgba(27,42,56,.05), 0 0 0 1px rgba(27,42,56,.13)`.
- **Sub-parts, left to right**:
  1. **Brand block** — 26×26 px square badge, `border-radius: 5px`, background `#1f74d8`, white monospace "DS" at 12px/700. To its right: title `드론 비행 시뮬레이터` at 13.5px/700, `letter-spacing: -0.01em`; below it the kicker `FLIGHT CONSOLE · SIM` at 10px, color `#93a3b0`, `letter-spacing: 0.02em`. The block is separated from the next by `border-right: 1px solid rgba(27,42,56,.13)` and `padding-right: 14px`.
  2. **Stats row** — five `<label>/<value>` pairs, `gap: 20px`. Label 9.5px `#93a3b0`; value 13px/600 monospace, tabular-nums. Labels/values in order: `비행 모드` (Korean mode name), `비행 시간` (`MM:SS`), `배터리` (`N %`), `홈 거리` (`N m`), `현재 좌표` (`X, Z`).
  3. **Status lamps** (`.tb-lamps`, `margin-left: auto`) — four pills, `gap: 6px`. Each: `padding: 4px 9px 4px 7px`, `border-radius: 99px`, 10.5px/600, with a 7px dot on the left (`gap: 5px`).
     - `ARM` / `DISARM` — armed = `#1d8a5f` text on `rgba(29,138,95,.07)` with `rgba(29,138,95,.22)` border, dot has a `0 0 0 3px rgba(29,138,95,.14)` halo; disarmed = neutral `#5d6f7e` on `#fbfbfa`.
     - `GNSS <n>` — `#b8791a` warn styling when sats < 10, otherwise ok styling.
     - `링크 양호` / `링크 약화` — ok styling when home distance < 300 m, warn otherwise.
     - `배터리 <n>%` — ok ≥ 30 %, warn 15–30 %, crit < 15 % (crit dot pulses: `@keyframes pulse { 50% { opacity: .35 } }`, 1 s infinite).
  4. **Clock** — `padding-left: 14px`, `border-left: 1px solid rgba(27,42,56,.13)`, 11px monospace `#5d6f7e`. Shows sim elapsed `MM:SS` then a lighter `SIM` suffix.

#### B. Telemetry strip (`Telemetry`, `.tstrip`)

- **Purpose**: the 10 live flight metrics, always visible.
- **Layout**: CSS grid, `grid-template-columns: repeat(10, minmax(0, 1fr))`, one row, no gap; white background, `border-radius: 7px`, same panel shadow, `overflow: hidden`. Each cell has `border-right: 1px solid rgba(27,42,56,.07)` (last cell none) and `padding: 8px 10px 9px`.
- **Cell anatomy** (`.ro`): label 9.5px `#93a3b0` (nowrap + ellipsis); value row = 17px/600 number + 9.5px `#93a3b0` unit, baseline-aligned, `gap: 3px`; optional sub-line 9.5px `#5d6f7e`.
- **The ten cells, exact labels and formats**:

  | # | Label | Value | Unit | Sub-line |
  |---|---|---|---|---|
  | 1 | 수평 속도 | `N.N` | km/h *(mph in imperial)* | `최대 N.N` |
  | 2 | 수직 속도 | `±N.N` | m/s | `상승` / `하강` / `유지` |
  | 3 | 고도 AGL | `N.N` | m *(ft)* | `MSL N.N m` |
  | 4 | 홈 거리 | `N` (0 dp) | m *(ft)* | `누적 N m` |
  | 5 | 배터리 | `N` (0 dp) | % | `4.16 V/cell · 16분` |
  | 6 | 비행 시간 | `MM:SS` | — | `최대고도 N m` |
  | 7 | 자세 | `N°` (yaw) | — | `P N.N / R N.N` |
  | 8 | GNSS | `N` | 기 | `HDOP N.NN · 양호` / `· 저하` |
  | 9 | 바람 | `N.N` | m/s | `NE 045° · 21.4°C` |
  | 10 | 모터 | `N.N` | k rpm | `부하 N%` |

- **Tone modifiers**: cells 5 and 8 apply `.ro-warn` (value turns `#b8791a`) or `.ro-crit` (`#c0392b`) — battery < 30 % / < 15 %, GNSS < 10 sats.
- **Responsive**: at ≤ 1420 px the strip becomes `repeat(5, 1fr)` over two rows (cells 6–10 get a `border-top`); at ≤ 980 px it becomes `repeat(3, 1fr)`.

#### C. Panel chrome (`PanelHead`, `.ph`)

Every panel is a white card (`.panel`) with the same shadow and `border-radius: 7px`, laid out as `flex-direction: column; overflow: hidden; min-height: 0`. Its header is a flex row, `padding: 6px 10px`, `border-bottom: 1px solid rgba(27,42,56,.13)`, background `linear-gradient(180deg, #fbfbfa, #fff)`:

- Left: title 11.5px/700 (nowrap) + optional code chip — 9px uppercase `letter-spacing: .06em`, `#93a3b0` on `#e9ecea`, `padding: 1.5px 5px`, `border-radius: 3px`.
- Right (`.ph-r`): nowrap, `overflow: hidden`, 10.5px `#5d6f7e`, typically one or more **value chips** (`.ph-tag`): monospace 10px/600, `padding: 2px 6px`, `border-radius: 4px`, `rgba(31,116,216,.08)` background / `#0f4c93` text. `.ok` variant = `rgba(29,138,95,.1)` / `#1d8a5f`. `.warn` = `rgba(184,121,26,.12)` / `#b8791a`.

#### D. Body grid (`.body`)

`display: grid; gap: 9px; flex: 1 1 auto; min-height: 0`. Every layout's **last row is 292 px tall** and spans all columns (`.span-all`) — it holds the flight controls, the history chart, and (in console layout) the power/link panel.

**Layout 1 — `console` (관제 콘솔 · 계기 + 3D)**, the default:

```
grid-template-columns: 268px minmax(0,1fr) 292px;
grid-template-rows:    minmax(0,1fr) 292px;
```

- Row 1 / Col 1: **계기판 (PFD)** — attitude indicator + altitude tape side by side (152 px tall), speed tape below (44 px), then a 2×2 key-value grid (`목표 고도`, `목표 속도`, `짐벌 피치`, `줌`).
- Row 1 / Col 2: **3D 지형 뷰** — fills, with an optional draggable camera PiP.
- Row 1 / Col 3: two stacked panels — **임무 경로 (MISSION)** on top (list capped at 190 px) and **이벤트 로그 (LOG)** filling the rest.
- Row 2 (span-all): **비행 제어** (`flex: 1 1 auto`) + **비행 이력 차트** (`min-width: 250px`) + **동력 / 링크** (fixed 264 px).

**Layout 2 — `map` (지도 중심 · 경로 비행)**:

```
grid-template-columns: minmax(0,1fr) 300px;
grid-template-rows:    minmax(0,1fr) 292px;
```

- Left: **2D 지도 뷰** filling the cell, with camera PiP. Right column stacked: **임무 경로** → **동력 / 링크** (fixed) → **이벤트 로그** (grows).

**Layout 3 — `cam` (카메라 중심 · 짐벌 시점)**:

```
grid-template-columns: minmax(0,1fr) 300px;
grid-template-rows:    minmax(0,1fr) 292px;
```

- Left: **짐벌 카메라 뷰** filling the cell (view background `#c9d4da` while the feed loads), with 2D map PiP. Right column: **계기판** (fixed) → **임무 경로** (list capped at 190 px).

**Layout 4 — `split` (분할 · 지도 + 3D 동시)**:

```
grid-template-columns: 300px minmax(0,1fr) minmax(0,1fr);
grid-template-rows:    minmax(0,1fr) 292px;
```

- Left column: **임무 경로** → **이벤트 로그**. Middle: **2D 지도 뷰**. Right: **3D 지형 뷰**.

At ≤ 1180 px all four layouts collapse to a single column with a `minmax(0,1fr)` row above the fixed 292 px row; side columns become horizontal (`flex-direction: row`).

---

### View 1 — 2D Map (`ViewMap`)

- **Purpose**: geographic overview — where the aircraft is, where it has been, where it is going.
- **Canvas fills the panel.** Background `hsl(45 20% 97%)`. Layers drawn bottom-to-top:
  1. **Terrain raster** — cached offscreen canvas, cell size `clamp(round(max(W,H)/190), 3, 24)` px. Each cell's fill comes from the elevation band ramp (below); shading = `clamp(-(gx*-0.62 + gz*-0.78) * 3.2, -1, 1)` applied at contrast `0.09`. Contour lines only where the band index changes; shoreline stroke `rgba(110,150,185,.4)` on water cells.
  2. **Roads** — two polylines (coordinates in `ROADS` in `render.js`), drawn twice: 5 px `rgba(255,255,255,.9)` casing with `lineCap: round`, then 1 px `rgba(150,160,165,.55)` centre.
  3. **Coordinate grid** (optional) — 50 m spacing when `ppm > 1.4`, else 100 m. Lines `rgba(60,80,100,.10)`; labels 9.5px/500 monospace `rgba(70,90,110,.6)` at 3 px / 4 px offsets.
  4. **Geofence** (optional) — dashed circle (`7,6`) radius `fence * ppm`, stroke `rgba(196,120,20,.55)` at 1.6 px.
  5. **Mission path** — dashed (`6,5`) polyline through waypoints, `rgba(31,116,216,.6)` at 1.6 px.
  6. **Flight trail** — polyline of the last 2200 positions; 7 px `rgba(31,116,216,.18)` underlay then 2.2 px `#1f74d8`.
  7. **Home marker** — 7 px circle, fill `#1d8a5f`, white 1.6 px ring, white monospace `H` centred.
  8. **Waypoints** — 7.5 px circles (`#fff` fill, `rgba(70,90,110,.7)` 1.8 px ring) with the index number in 10px/700 monospace `#3a4b59`. The **active** waypoint is 9 px, filled `#1f74d8`, white number, plus a pulsing ring at `15 + sin(now/320) * 2.5` px, `rgba(31,116,216,.5)`.
  9. **Aircraft + camera FOV** — FOV wedge = `rgba(31,116,216,.13)` sector, radius `190 * ppm`, half-angle 34°, oriented to yaw. Aircraft = 22 px arrow (`0,-11 → 7.5,8 → 0,4.5 → -7.5,8`) filled `#0f4c93` with a 1.6 px white outline, rotated to yaw.
  10. **Scale bar** — bottom-right, 24 px inset. Bar length = 50 / 100 / 200 m depending on zoom. End ticks 8 px tall, 1.4 px `rgba(40,60,80,.7)` stroke; label `600 10px` monospace `rgba(40,60,80,.85)` right-aligned above.
  11. **Compass** — top-left, at (30, 34). 18 px vertical needle with a filled triangle head and a `700 9px` monospace `N` above.
- **Overlay controls** (HTML, not canvas):
  - **Zoom stack** (`.map-tools`, top-right, 9 px inset, `gap: 4px`): three 26×26 px buttons, `border-radius: 5px`, `border: 1px solid rgba(27,42,56,.13)`, `background: rgba(255,255,255,.92)` + `backdrop-filter: blur(6px)`, glyphs `+` / `−` / `⌖`, 14 px, colour `#5d6f7e`. Hover: colour `#1f74d8`, border `rgba(31,116,216,.4)`. The `⌖` (follow) button's active state is solid `#1f74d8` with white glyph. Transition `.12s`.
  - **HUD chip** (`.map-hud`, top-left, 9 px inset): 9.5px monospace `#5d6f7e` on `rgba(255,255,255,.84)` with a 1 px `rgba(27,42,56,.13)` border and 3 px radius; shows `X, Z` and `1:<ppm⁻¹>`, separated by a 1×9 px divider.
- **Interaction**: pointer-down + drag pans (`cursor: grab` → `grabbing`); wheel zooms (×1.16 in, ×0.86 out, clamped to `ppm ∈ [0.14, 5.2]`); dragging disables follow; `⌖` toggles follow, which eases the camera centre toward the aircraft at 0.16 per frame.

### View 2 — 3D Terrain (`View3D`)

- **Purpose**: spatial understanding of the aircraft's position above terrain.
- **Renderer**: hand-written perspective projection. View matrix built from `camPos` and `target` with an up vector of `(0,1,0)`; focal length `f = (H/2) / tan(fov/2)`, `fov = 52°`. Projection returns `null` when `vz < 0.6` (near-plane clipping).
- **Terrain mesh**: grid of cells around the aircraft; cell size is auto-raised so the total quad count stays ≤ **620** in the 3D view (480 in the camera view) — this budget is what keeps the frame time sane. Quads are painter-sorted far→near by view-space depth.
- **Fog**: quads fade toward the sky with `globalAlpha = 1 - fog * 0.92`, where `fog = clamp((depth - 0.55*extent) / (1.02*extent - 0.55*extent), 0, 1)`. This removes the hard straight edge where the terrain mesh ends.
- **Sky**: vertical gradient `hsl(207 62% 90%)` → `hsl(203 50% 95.5%)` (42 %) → `hsl(45 28% 97%)` (72 %) → `hsl(38 22% 96%)`.
- **Aircraft glyph**: quadcopter drawn as 4 arms (`scale = 7` world units) from a centre hub, each ending in a white ellipse rotor (`radius = clamp(420/z, 2.5, 11)`, `ry = 0.5*rx`), arms `rgba(24,40,58,.85)` at 2 px, hub `#0f4c93`. A nose line (`#1f74d8`, 2.4 px) points along yaw. Ground shadow ellipse at `rgba(40,60,50,.20)` with a dashed `rgba(31,116,216,.45)` drop line. A white chip labelled `AGL N.N m` floats 14 px right / 16 px above the hub.
- **Altitude ticks**: 10 m horizontal ticks from 10 m up to the current altitude, `rgba(31,116,216,.30)`, 12 px wide.
- **Waypoint markers**: dashed corridor polyline through waypoints (`rgba(31,116,216,.5)`); each waypoint gets a stem from its altitude down to the ground (`rgba(31,116,216,.85)` when active, `rgba(70,90,110,.42)` otherwise), a 3.5–11 px dot, and a chip `WP<n> · <alt>m`. Home is a 8–24 px green house glyph (`#1d8a5f`, white 1.4 px outline).
- **Gimbal FOV cone**: two `rgba(31,116,216,.35)` lines 90 m out at ±30°, plus a `rgba(31,116,216,.10)` fill.
- **Camera modes**:
  - `orbit` (궤도) — user-controlled azimuth/elevation/distance. Pointer drag changes azimuth (`-dx * 0.42`) and elevation (`+dy * 0.32`, clamped 6–84°); wheel changes distance ×0.9 / ×1.11, clamped 60–1500. Defaults `a=200°, e=26°, d=340`. Smoothing `lerp 0.12`.
  - `chase` (추적) — always `yaw + 180`, elevation 14°, distance `92 + alt * 1.5`. Smoothing `lerp 0.09`.
  - `top` (탑다운) — azimuth 180°, elevation 74°, distance `210 + alt * 1.3`.
  - Camera Y is floored at `groundY + 4`.
- **Hint chip** (`.v3-hint`, bottom-left, 9 px / 8 px inset): 9.5px monospace `#5d6f7e` on `rgba(255,255,255,.84)`, text depends on mode: `드래그 회전 · 휠 줌` / `추적 시점 · 기체 후방` / `탑다운 시점`.

### View 3 — Gimbal Camera (`ViewCam`)

- **Purpose**: the aircraft's eye view, with a camera HUD.
- **Renderer**: same projection code as the 3D view, but the camera sits at the aircraft and looks along `yaw + gimbalYaw` with pitch `gimbalPitch`, distance 620, and the horizon is rolled by `-roll` so the image banks with the aircraft. FOV = `78° / zoom`.
- **HUD** (all white, drawn over the terrain):
  - **Corner brackets** — 4 L-shapes, 22 px inset, 26 px arms, `rgba(255,255,255,.92)` at 1.6 px.
  - **Reticle** — centre cross with a 5 px gap, 16 px arms, plus a 3 px centre circle.
  - **Pitch ladder** — marks every 10° from −30° to +30°, positioned at `H/2 + (pitchDeg - gimbalPitch) * ppd` where `ppd = (H/2) / tan(fov/2) * DEG`. Horizontal tick half-width 46 px at 0°, 26 px elsewhere, drawn 8 px either side of centre, `rgba(255,255,255,.55)`.
- **In production**: replace the canvas terrain with the real video feed and keep the HUD overlay. The map PiP variant (`map` layout) shows the 2D map scaled to the aircraft with a 1050 m reference width.

### View 4 — Instruments (`Instruments`)

Three live canvases in the left column of `console` layout:

- **Attitude indicator** — clipped to a 6 px rounded rect. Sky gradient `hsl(206 72% 90%)` → `hsl(203 62% 84%)`; ground `hsl(36 30% 72%)` → `hsl(32 26% 60%)`. Horizon line white 1.6 px. The sky/ground group rotates `-roll` and translates by `pitch * ppd` (`ppd = H/62`). Pitch ladder at 5° steps, tick half-width 46 px (10°) / 24 px (5°), labels 9px/600 monospace white. Fixed overlay: roll scale ticks every 10° from −60° to +60° at radius `min(W,H) * 0.46` (`rgba(27,42,56,.35)`, longer ticks every 30°), a filled `#1f74d8` roll pointer triangle, and an aircraft symbol (`#1f74d8`, 2.4 px, `round` caps). Read-outs `P ±N.N°` top-left and `R ±N.N°` top-right in `700 11px` monospace `#1b2a38`.
- **Altitude tape** — right-anchored vertical scale, `0.42 m/px`. 5 m minor ticks (8 px) and 25 m major ticks (16 px) with right-aligned 9.5px/600 labels at 5 px left of the tick. A dashed `rgba(184,121,26,.45)` line with a filled triangle marks the commanded altitude. Current altitude pointer = filled `#1f74d8` triangle at the centre, plus a solid `#1f74d8` value box (4 px radius) with white `700 15px` monospace text.
- **Speed tape** — horizontal, 0–18 m/s across the width. Baseline at `H-16`, 3 m/s ticks with 9px labels below. A `#1f74d8` gradient bar (`#1f74d8` → `#1f74d855`) 11 px tall above the baseline, width `min(W-8, vh * px)`. Read-outs: speed `700 15px` top-left, unit `600 10px` `#93a3b0`, and `VSI ±N.N m/s` right-aligned `#5d6f7e`.
- **Key-value rows** below: `목표 고도` / `목표 속도` / `짐벌 피치` / `줌`, 10.5px label `#93a3b0`, 11px/600 monospace value, nowrap, 2×2 grid, `gap: 3px 10px`.

### View 5 — History chart (`ChartPanel`)

- **Purpose**: last 90 s of altitude, ground speed, and battery on one plot.
- **Layout**: `padding: 10px 10px 6px`, `gap: 6px`. Header row: title `비행 이력 · 최근 90초` 10.5px/600 `#5d6f7e` on the left; legend on the right (`고도` / `속도` / `배터리`) — 9.5px `#93a3b0`, each with a 10×2 px rounded swatch (`#1f74d8` / `#1d8a5f` / `#b8791a`). Plot area is a `1px solid rgba(27,42,56,.13)` rounded-6 box, `min-height: 110px`.
- **Plot**: left axis 26 px, right 8 px, top 8 px, bottom 14 px. Four horizontal gridlines at 0/25/50/75/100 % of `maxAlt` (auto-scaled to `max(60, ceil(maxAlt/20)*20 + 20)`), `rgba(27,42,56,.08)`, with right-aligned 8.5px labels. **Altitude** = `#1f74d8` 1.7 px line over a vertical gradient area fill (`#1f74d844` → `#1f74d808`). **Speed** = `rgba(29,138,95,.85)` 1.3 px dashed (`3,3`), scaled to a fixed 65 km/h max. **Battery** = `rgba(184,121,26,.6)` 1.1 px, 0–100 %. X-axis labels `-90s` (left) and `now` (right) in 8.5px `#93a3b0`. Empty state: centred `데이터 수집 대기` in 10px/600 monospace `#93a3b0`.
- **Sampling**: one sample every 0.25 s of sim time, ring buffer of 360 samples.

### View 6 — Mission list (`MissionList`)

- Five rows, one per waypoint. Grid `18px 42px 1fr 26px 62px`, `gap: 6px`, `padding: 5px 10px`, 10.5px, `border-left: 2px solid transparent`.
- Columns: index badge (17×17 px circle, 9px/700 monospace), name (`WP1`…), altitude (`45 m`, `#5d6f7e`), hover dwell (`4s`, `#93a3b0`, right-aligned), distance (`163 m`, right-aligned `#5d6f7e`).
- States: **active** = `rgba(31,116,216,.07)` row background, `#1f74d8` left border, badge filled `#1f74d8` with white number; **done** = 50 % row opacity, badge filled `#1d8a5f` with white number, distance column reads `완료` in `#1d8a5f`; hover = `#fbfbfa` row background.

### View 7 — Event log (`EventLog`)

- Scrolling list, newest first, capped at 48 entries. Row grid `40px 34px 1fr`, `gap: 7px`, `padding: 4px 10px`, 10.5px, `line-height: 1.45`, `border-left: 2px solid transparent`, `border-top: 1px solid rgba(27,42,56,.07)` between rows.
- Columns: elapsed `MM:SS` (9.5px `#93a3b0`), level word (9px/700), message.
- Levels and styling:

  | Level | Word | Left border | Row background | Word colour | Message colour |
  |---|---|---|---|---|---|
  | ok | 정상 | `#1d8a5f` | — | `#1d8a5f` | `#5d6f7e` |
  | info | 정보 | transparent | — | `#1f74d8` | `#5d6f7e` |
  | warn | 주의 | `#b8791a` | `rgba(184,121,26,.05)` | `#b8791a` | `#1b2a38` |
  | crit | 경고 | `#c0392b` | `rgba(192,57,43,.055)` | `#c0392b` | `#1b2a38` |

- Empty state: `기록된 이벤트 없음`, centred, `#93a3b0`.

### View 8 — Flight controls (`Controls`)

Four columns, `grid-template-columns: 1.25fr 1.5fr 1fr 1fr`, `gap: 10px`, `padding: 10px`, `overflow-y: auto`, `align-content: start`. (≤ 1400 px → 2 columns.)

1. **비행 명령** — 2-column button grid. Buttons are `padding: 8px 10px`, `border-radius: 6px`, 11.5px/600, `border: 1px solid rgba(27,42,56,.13)`, `background: #fbfbfa`, label left + keyboard hint right. A `<kbd>` hint is 9.5px monospace `#93a3b0` on `#e9ecea`, `padding: 1px 4px`, 3 px radius. Hover: `border-color: rgba(31,116,216,.45)`, `background: rgba(31,116,216,.05)`. Active: `transform: translateY(.5px)`.
   - `이륙` `T` · `자동 임무` `M` · `호버 홀드` `H` · `귀환` `R` · `착륙` `L` · `초기화` (danger variant) · full-width `시나리오 재생 · 이륙 → 순항 → 호버 → 착륙`.   - `.primary` = solid `#1f74d8`, white text, hover `#0f4c93`. Applied dynamically to the button matching the current mode (AUTO / HOLD / RTL / LAND).
   - `.danger` hover = `rgba(192,57,43,.06)` background, `#c0392b` text, `rgba(192,57,43,.5)` border.
2. **스틱 입력** — two `Joystick` components side by side (`gap: 14px`, space-around). Each joystick: square `aspect-ratio: 1` circle up to 116 px, radial-gradient background (`#fff` → `#e9ecea`), 1 px border, inner dashed ring at 16 % inset, thin cross-hairs at 8 % inset, and a 34 %-wide `#1f74d8` knob with `box-shadow: 0 2px 6px rgba(31,116,216,.35)`. `touch-action: none`. Below: label 10.5px/600 and sub-label 9px `#93a3b0` — `좌 스틱` / `스로틀 / 요` and `우 스틱` / `피치 / 롤`.
   Section header carries a live note: `자동 비행 중 · 입력 시 수동 전환` (in `#1f74d8`) or `수동 조종 가능`.
3. **시뮬레이션** — a segmented control (`.seg`: `#e9ecea` track, 2 px padding, 6 px radius; buttons flex-1, 5px/4px padding, 10.5px/600 `#5d6f7e`; active = white background, `#0f4c93` text, `0 1px 2px rgba(27,42,56,.1)`). Speed `0.5× / 1× / 2× / 4×`; playback `재생 / 일시정지`. Then two labelled range sliders: `목표 고도` 10–120 m step 5, `카메라 줌` 1–4× step 0.1. Slider track 4 px `#e9ecea` rounded; thumb 13 px circle `#1f74d8` with a 2 px white ring and `0 1px 3px rgba(27,42,56,.28)`.
4. **표시 옵션** — a 2-column switch grid. `Switch`: full-width row, 6px/8px padding, 11px/500, label left, optional key hint, then a 26×15 px pill track (`rgba(27,42,56,.16)` off / `#1f74d8` on) with an 11 px white knob that translates 11 px. Items: `좌표 그리드` `G`, `비행 궤적`, `웨이포인트`, `지오펜스`. Below: a 3-way segmented control for the 3D camera — `궤도` / `추적` / `탑다운`. Finally a full-width ghost button `PiP 위치 초기화` (`margin-top: 5px`) which clears the `ds.pip.cam` and `ds.pip.map` localStorage keys and reloads — a recovery affordance in case a PiP is ever dragged somewhere unhelpful.

### View 9 — Power / link (`PowerPanel`)

Two stacked blocks separated by a 1 px `rgba(27,42,56,.07)` divider.

- **Battery** (`BatteryPanel`) — header row: `배터리 팩` 10.5px `#5d6f7e` left, percentage `700 15px` right (turns `#b8791a` < 35 %, `#c0392b` < 20 %). Four vertical cell gauges (`gap: 6px`): a `1px` bordered rounded-4 box 38 px tall, `#fbfbfa` background, 2 px padding, filled bottom-up by a `linear-gradient(180deg, #35a874, #1d8a5f)` bar whose height maps cell voltage `3.45–4.21 V` to 0–100 %; a 9.5px `#5d6f7e` voltage label below each. Footer (`border-top`, 6 px gap): `전압 16.66 V` and `잔여 16 분`, 10px `#93a3b0`.
- **Link** (`LinkPanel`) — three `label / value` rows (10.5px `#5d6f7e` / 10.5px/600 `#1b2a38`) each followed by a 4 px rounded progress bar (`#e9ecea` track; fill `#1f74d8`, `.bar-warn` `#b8791a` below 60 %, `.bar-crit` `#c0392b` below 35 %):
  - `제어 링크` — `-NN dBm`, where RSSI = `max(-95, -52 - distHome*0.06 - gust*1.4)`; quality = `clamp((rssi + 95) / 43, 0, 1)`.
  - `영상 링크` — `1080p 30fps` (q > 0.55) / `720p 30fps` (q > 0.3) / `480p 15fps`.
  - `지연` — `42 + (1 - q) * 160` ms.

### View 10 — Draggable PiP (`Pip`)

- Used for the gimbal camera (in `console` / `map` layouts) and the 2D map (in `cam` layout).
- Position is stored as **fractions of the parent view** and persisted to `localStorage` under `ds.pip.cam` / `ds.pip.map`. On mount, the stored position is restored.
- **Default position matters.** With no stored position the PiP must be anchored by CSS (`right: 10px; bottom: 10px`) — it is `position: absolute` inside `.view`, which has `overflow: hidden`, so an un-anchored element falls back to static flow *after* the 100 %-height canvas and gets clipped out of sight entirely (and becomes undraggable, since its header is outside the box).
- **Dragging uses pixel deltas** against the host's `clientWidth/clientHeight`, clamped to `[0, host - pipSize]`, then converted back to fractions. Do not clamp to fixed fractions — the clamp must depend on the PiP's own size and the current host size, or a small PiP can't reach the edges and a resized window can push a stored position off-screen.
- On mount (and on size change) a stored position is pulled back inside the current host bounds, then re-persisted. This handles layout switches and window resizes.
- A `PiP 위치 초기화` button in the flight-controls panel clears both `localStorage` keys and reloads.
- Header bar: `padding: 3px 4px 3px 8px`, `#fbfbfa` background, bottom border, `cursor: grab` → `grabbing`, `touch-action: none`, `user-select: none`. Title 10px/700; a 18×18 px `⤢` button cycles size.
- Sizes: `.pip-sm` 24 % / `.pip-md` 34 % / `.pip-lg` 46 % of the parent width; body is `aspect-ratio: 16/9` (16/10 for `lg`).
- Container shadow: `0 6px 22px rgba(27,42,56,.18), 0 0 0 1px rgba(27,42,56,.13)`, `z-index: 5`.

---

## Interactions & Behavior

### Flight modes

`MODE_KR` maps internal modes to Korean labels shown in the top bar:

| Mode | Label | Entered by | Behaviour |
|---|---|---|---|
| `IDLE` | 대기 | startup, after touchdown, reset | velocities damp to zero |
| `TAKEOFF` | 이륙 | `이륙` / `T`, or `자동 임무` while on the ground | vertical rate `clamp((targetAlt - alt) * 0.6, -2.5, 3.0)` m/s; hands off to `AUTO` if a mission is pending, else `HOLD` |
| `MANUAL` | 수동 | any joystick/keyboard input | full stick authority; see stick mapping below |
| `AUTO` | 자동 임무 | `자동 임무` / `M` | flies the waypoint list; see mission state machine |
| `HOLD` | 호버 홀드 | `호버 홀드` / `H` | holds position, altitude servos to `targetAlt` |
| `RTL` | 귀환 | `귀환` / `R`, or battery < 15 % | climbs to `max(48, targetAlt)` m and returns home; switches to `LAND` within 7 m of home |
| `LAND` | 착륙 | `착륙` / `L`, RTL completion, or battery at 0 % | descends at 1.1 m/s; disarms and logs flight time on touchdown |

Every mode transition is logged (`모드 전환 · <label>`), except when suppressed with `silent`.

### Manual control mapping

| Input | Effect |
|---|---|
| Left stick X | yaw rate, ±70 °/s |
| Left stick Y | climb/descend, ±5 m/s (dead zone ±0.07) |
| Right stick Y | forward/back, up to 18 m/s |
| Right stick X | strafe left/right, up to 18 m/s |
| `W` / `S` | forward / back |
| `A` / `D` | yaw left / right |
| `↑` / `↓` | climb / descend |
| `←` / `→` | yaw left / right |
| `Shift` | forward boost |
| `Space` | strafe boost |

Horizontal velocity is damped toward the target with `τ = 0.95 s`; vertical with `τ = 0.7 s`. **Any stick deflection > 0.5 while in `AUTO` / `RTL` / `HOLD` cancels the automated mode** and switches to `MANUAL`, logging `조종 입력 감지 · 수동 모드로 전환`. Keyboard listeners ignore events whose target is an `INPUT` or `SELECT`.

### Keyboard shortcuts

`T` takeoff · `M` auto mission · `H` hold · `R` return · `L` land · `P` pause/resume sim · `G` toggle coordinate grid.

### Mission state machine (`AUTO`)

Per waypoint: `transit` → `hover` → next. During transit the aircraft faces the waypoint (yaw rate `clamp(err * 1.9, ±70)` °/s), and its ground speed is scaled by alignment (`cos(yawErr)` mapped to 0.22–1.0) so it banks into the turn rather than sliding sideways. Target speed is `clamp(dist * 0.42, 2.4, cruise)` while far, `min(dist * 0.5, 1.4)` within 6.5 m. Altitude servos at `clamp(altErr * 0.55, ±2.6)` m/s. Arrival is `dist < 6.5 m && |altErr| < 3.5 m`, which logs `WP<n> 도착 · <d>초 호버` and dwells for the waypoint's `hover` seconds. After the last waypoint the aircraft automatically enters `RTL`.

### Warning logic (all latched, logged once)

| Trigger | Level | Message |
|---|---|---|
| battery < 25 % | warn | `배터리 25% 이하 · 임무 단축 권장` |
| battery < 15 % | crit | `배터리 15% 이하 · 즉시 귀환 필요` + forces `RTL` |
| battery ≤ 0 % | crit | `배터리 방전 · 자동 착륙` |
| sats < 9 | warn | `GNSS 위성 부족 (n) · 위치 정밀도 저하` (clears at ≥ 11) |
| home distance > 420 m | warn | `지오펜스 경계 접근 · 반경 420 m 초과` (clears at < 380 m) |
| gust > 3 m/s | warn | `강풍 돌풍 감지 · N.N m/s` (clears below 1) |

### Animation & transition timings

| Element | Property | Duration | Easing |
|---|---|---|---|
| Panel/button/switch/segment hover | colour, border, background | `.12s` | linear |
| Button press | `transform: translateY(.5px)` | instant | — |
| Switch knob | `transform` | `.15s` | linear |
| Switch track | `background` | `.15s` | linear |
| Segmented control thumb (Tweaks panel) | `left`, `width` | `.15s` | `cubic-bezier(.3,.7,.4,1)` |
| Progress bar fill | `width` | `.25s` | linear |
| Cell gauge fill | `height` | `.3s` | linear |
| Joystick knob | `left`, `top` | `.06s` | linear |
| Crit status lamp dot | `opacity` | `1s` | infinite (50 % at mid) |
| Active waypoint ring (map) | radius | continuous | `sin(now / 320)`, ±2.5 px |
| 3D/2D camera follow | position | per-frame lerp | `0.16` (map), `0.12`/`0.09` (3D) |

### Performance contract (important — this is what makes the design feel right)

- **Simulation**: fixed 1/60 s timestep with an accumulator, so physics is frame-rate independent and identical at 1× or 4× sim speed. Max 20 catch-up steps per frame.
- **React re-render cadence**: high-frequency read-outs (telemetry strip, instruments, top bar) are polled by `setInterval` at **110–260 ms**, *not* per animation frame. Only canvas draw loops run per-frame.
- **Canvas draw cadence**: 2D map and 3D views run per-frame; the mini map is throttled to 15 fps; the history chart to 12 fps.
- **Terrain raster cache**: the 2D map caches its terrain into an offscreen canvas keyed on `(width, height, snapped centre, m/px, cell size)`. The centre is snapped to 3 cell widths so the cache survives sub-cell panning. **Each map instance needs its own cache** — sharing one cache between the main map and the mini map causes them to invalidate each other every frame (this was an actual bug during design).
- **3D quad budget**: ≤ 620 quads (3D view) / ≤ 480 (camera view), enforced by auto-raising the cell size.
- **Tick loop**: a single shared ticker (`window.Tick`) drives all canvas loops and the sim. It runs `requestAnimationFrame` plus a `setInterval` watchdog that only fires if rAF has not run for 60 ms. This is deliberate: in a non-composited or background iframe, rAF can stop entirely, and without the watchdog the whole console freezes. `dt` is always measured from the previous tick, so whichever path fires first advances time by the correct amount and the sim never double-speeds.

### Responsive behaviour

| Breakpoint | Change |
|---|---|
| ≤ 1420 px | telemetry strip → 5 columns × 2 rows; console layout columns → `232px / 1fr / 256px`; controls → 2 columns |
| ≤ 1200 px | top-bar stats 4 and 5 hidden |
| ≤ 1180 px | all body layouts collapse to one column + the 292 px bottom row; side columns become horizontal |
| ≤ 980 px | top-bar stats hidden entirely; telemetry strip → 3 columns |

---

## State Management

### Simulation state (`DroneSim.state`)

A single mutable object. Groups:

- **Time / control**: `t`, `simSpeed`, `running`, `mode`, `modeSince`, `armed`, `motorsOn`
- **Pose**: `x`, `z`, `alt`, `yaw`, `pitch`, `roll`, `groundY`, `msl`
- **Velocity**: `vx`, `vz`, `vv`, `vh`
- **Power**: `battery` (%), `cellV` (V), `remainMin`, `rpm`
- **Navigation**: `sats`, `hdop`, `home {x,z}`, `distHome`, `dist`, `fence`
- **Mission**: `waypoints[] {x,z,alt,hover}`, `missionIdx`, `wpState`, `hoverT`, `missionActive`
- **Environment**: `windSpd`, `windDir`, `gust`, `temp`
- **Camera**: `gimbalPitch`, `gimbalTarget`, `zoom`
- **Session stats**: `flightTime`, `maxAlt`, `maxSpd`
- **Buffers**: `trail[] {x,z,alt}` (≤ 2200), `hist[] {t,spd,alt,bat,dist}` (≤ 360), `events[] {id,t,level,text}` (≤ 48)
- **Input**: `stick {lx,ly,rx,ry}`, `keys {}`, `input {thr,yaw,pitch,roll}`
- **View flags**: `showGrid`, `showTrail`, `showMarkers`, `showFence`, `camMode`
- **Latch flags** (internal, for once-only warnings): `_w25`, `_w15`, `_ws`, `_wf`, `_wg`, `_hT`

### Simulation constants

| Constant | Value | Meaning |
|---|---|---|
| `MAX_SPEED` | 18 m/s | max horizontal speed |
| `MAX_VS` | 5 m/s | max vertical speed |
| `MAX_YAW_RATE` | 70 °/s | max yaw rate |
| `WATER` | −7.2 m | terrain height below which cells render as water |
| default `fence` | 420 m | geofence radius |
| default `targetAlt` | 45 m | commanded altitude |
| default `cruise` | 9 m/s | mission cruise speed |
| battery load | `0.072 + 0.030*|thr| + 0.030*(vh/MAX_SPEED) + 0.02*max(0, vv/MAX_VS)` %/s | ~22 min endurance at hover |
| cell voltage | `3.45 + (battery/100)*0.76 - (armed ? 0.05*(load/0.1) : 0)` V | 4.21 → 3.45 V |

### Terrain function

`terrainH(x, z) = 9.0*sin(x/95)*cos(z/115) + 5.2*sin((x + z*0.6)/58) + 3.2*cos((z - x*0.5)/37) + 1.6*sin((x*0.31 + z*0.27)/17)`

World extents used by the views: ±540 m. Coordinate convention: **x = east, z = south** (so north is −z and the map's up direction). Yaw 0° = north.

### UI state (per-layout React state)

- `pipSize` — `sm` | `md` | `lg`, cycles on the PiP `⤢` button
- Map view ref — `{ cx, cz, ppm, init }` plus a `follow` flag; a 400 ms interval publishes `{ppm, follow, center}` to React for the HUD chip only
- 3D camera ref — `{ a, e, d }` (user targets) and `{ a, e, d, tx, ty, tz, init }` (smoothed current)
- Per-panel polled snapshots (`snapTop`, `ctlSnap`, `snapshot`, `snapshot2`) — deliberately coarse, throttled

### Data fetching

**None.** Everything is generated locally. If this is wired to a real aircraft, the natural seam is: replace `sim.js`'s `tick()` with an ingest function that writes into the same `state` shape, and keep every renderer and panel unchanged.

---

## Design Tokens

### Colors

| Token | Value | Use |
|---|---|---|
| `--bg` | `#f1f3f2` | app background (slightly green-tinted neutral) |
| `--bg-2` | `#e9ecea` | inset surfaces, switch tracks, code chips, segmented-control track |
| `--panel` | `#ffffff` | all cards |
| `--panel-2` | `#fbfbfa` | panel headers, secondary buttons |
| `--ink` | `#1b2a38` | primary text |
| `--sub` | `#5d6f7e` | secondary text |
| `--faint` | `#93a3b0` | tertiary text, labels, units |
| `--line` | `rgba(27,42,56,.13)` | borders, panel outline (inside the shadow) |
| `--line-2` | `rgba(27,42,56,.07)` | separators inside panels |
| `--accent` | `#1f74d8` | the single accent — aircraft, current value, active state |
| `--accent-d` | `#0f4c93` | accent pressed / darker fills |
| `--ok` | `#1d8a5f` | healthy status |
| `--warn` | `#b8791a` | caution status |
| `--crit` | `#c0392b` | danger status |

**Accent alternates** (Tweaks panel): `#1f74d8`→`#0f4c93`, `#0f7b6c`→`#08584d`, `#7a4fd0`→`#573399`, `#b8791a`→`#8a5810`.

**Terrain land ramp** — six HSL bands indexed by `clamp(floor((h + 20) / 6.8), 0, 5)`, then lightness scaled by `clamp(L * (1 + 0.09 * shade), 62, 99)`:

| Band | Hue | Sat | Base L |
|---|---|---|---|
| 0 | 146 | 19 % | 90.0 % |
| 1 | 126 | 17 % | 91.8 % |
| 2 | 98 | 15 % | 92.4 % |
| 3 | 70 | 19 % | 92.8 % |
| 4 | 46 | 23 % | 93.2 % |
| 5 | 32 | 21 % | 91.0 % |

**Terrain water ramp** — `t = clamp((WATER - h) / 9, 0, 1)`, then `hsl(203, 40 + t*18 %, 92 - t*13 %)`.

**Attitude indicator**: sky `hsl(206 72% 90%)` → `hsl(203 62% 84%)`; ground `hsl(36 30% 72%)` → `hsl(32 26% 60%)`.

**Sky gradient** (3D views): `hsl(207 62% 90%)` → `hsl(203 50% 95.5%)` @42 % → `hsl(45 28% 97%)` @72 % → `hsl(38 22% 96%)`.

### Spacing

There is no separate spacing scale — spacing is expressed through three CSS variables plus component-local values:

| Token | Standard | Compact | Roomy |
|---|---|---|---|
| `--pad` (inner panel padding) | 10px | 8px | 14px |
| `--gap` (grid/flex gap) | 9px | 6px | 12px |
| `--fs` (base font size) | 12px | 11.5px | 12.5px |
| `--r` (border radius) | 7px | 6px | 7px |

Recurring local values: panel header padding `6px 10px`; button padding `8px 10px`; small chip padding `2px 6px`; grid gaps inside panels `3–8px`; the fixed bottom row height **292 px**; the console layout column widths **268 / 1fr / 292 px**.

### Typography

Two families, both from Google Fonts:

```
IBM Plex Sans KR  (400, 500, 600, 700)  → all UI text
IBM Plex Mono     (400, 500, 600, 700)  → every numeral, plus code chips and keyboard hints
```

CSS variables: `--sans: "IBM Plex Sans KR", "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Malgun Gothic", sans-serif`; `--mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace`.

**All numeric text uses `font-variant-numeric: tabular-nums`** so digits do not shift as values change. This is applied globally to the numeric selectors listed in `styles.css`.

| Role | Size | Weight | Notes |
|---|---|---|---|
| Panel title | 11.5px | 700 | `letter-spacing: -0.01em`, nowrap |
| Telemetry value | 17px | 600 | `letter-spacing: -0.02em`, line-height 1.15 |
| Telemetry label / sub | 9.5px | 400 | `#93a3b0` / `#5d6f7e` |
| Top-bar value | 13px | 600 | monospace |
| Top-bar label | 9.5px | 400 | `#93a3b0`, `letter-spacing: 0.03em` |
| App title | 13.5px | 700 | `letter-spacing: -0.01em` |
| Status lamp | 10.5px | 600 | |
| Panel code chip | 9px | 600 | uppercase, `letter-spacing: 0.06em` |
| Section label (`.sect`) | 9.5px | 700 | uppercase, `letter-spacing: 0.07em`, `#93a3b0` |
| Button | 11.5px | 600 | |
| Body / list text | 10.5px | 400–600 | |
| Event log message | 10.5px | 400 | line-height 1.45 |
| Gauge read-out | 15px / 11px | 700 | monospace |
| Axis / tick label | 8.5–9.5px | 500–600 | monospace, `#93a3b0` |

Minimum text size anywhere in the design is **8.5 px**, used only for chart axis labels; interactive text is ≥ 10.5 px.

### Border radius

| Value | Use |
|---|---|
| 3px | code chips, small tags, keyboard hints, HUD chips |
| 4px | panel value tags, cell gauge boxes, value boxes |
| 5px | brand badge, map tool buttons |
| 6px | buttons, switches, joysticks, segmented controls, view inner frames, PiP |
| 7px | panels, top bar, telemetry strip |
| 99px | status lamps, progress-bar tracks, slider tracks |

### Shadows

| Token | Value | Use |
|---|---|---|
| `--shadow` | `0 1px 2px rgba(27,42,56,.05), 0 0 0 1px rgba(27,42,56,.13)` | all panels, top bar, telemetry strip |
| PiP | `0 6px 22px rgba(27,42,56,.18), 0 0 0 1px rgba(27,42,56,.13)` | floating PiP windows |
| Joystick knob | `0 2px 6px rgba(31,116,216,.35), inset 0 1px 0 rgba(255,255,255,.4)` | |
| Slider thumb | `0 1px 3px rgba(27,42,56,.28)` | |
| Toast | `0 8px 24px rgba(0,0,0,.22)` | |

### Elevation / layering

Panels sit on `--bg` with a 1 px outline baked into the shadow rather than a separate border. Canvas views are inset 1 px inside their panel and carry a subtle inner top/bottom hairline (`.view::after`) so the raster edge reads as a bezel.

---

## Assets

**No binary assets, images, icons, or fonts are bundled.**

- **Typefaces**: IBM Plex Sans KR and IBM Plex Mono, loaded from Google Fonts. If the target codebase self-hosts fonts, use `next/font`, `@fontsource/ibm-plex-sans-kr` + `@fontsource/ibm-plex-mono`, or equivalent. The Korean subset is required.
- **Icons**: the design uses **text glyphs only** — `+`, `−`, `⌖`, `⤢`. No icon font or SVG set is needed. If the codebase has an icon library, these three controls (`map zoom in`, `map zoom out`, `follow aircraft`, `cycle PiP size`) are the only ones to map.
- **Imagery**: none. Terrain is generated procedurally; there are no placeholder images.
- **The gimbal camera view needs a real video feed in production** — plan for an `<video>` element or WebRTC stream behind the canvas HUD. No asset is provided because the prototype renders synthetic terrain there.

---

## Files

All files live at the project root. The prototype entry point is `index.html`.

| File | Lines | Contents |
|---|---|---|
| `index.html` | 66 | Entry point. Loads fonts, `styles.css`, then the three plain scripts in dependency order (`util.js` → `sim.js` → `render.js`), then the five Babel-transpiled JSX modules. Also holds the `TWEAK_DEFAULTS` JSON block between `/*EDITMODE-BEGIN*/` and `/*EDITMODE-END*/` markers. |
| `util.js` | 62 | `window.Tick` shared frame ticker (rAF + watchdog) and `window.SimUtil` unit conversion + number/time/bearing formatters. `window.SimU` holds the live `{sys, accent}` display settings. |
| `sim.js` | 362 | The simulation engine: terrain height function, state object, flight-mode controllers, mission state machine, battery/GNSS/wind models, warning latching, fixed-timestep tick. Exposes `window.DroneSim`. |
| `render.js` | 587 | All three canvas renderers: `renderMap` (with the offscreen terrain cache), `renderScene` (3D terrain + aircraft + markers), `renderCam` (gimbal view + HUD), plus the projection math, colour ramps, and the road polylines. Exposes `window.DroneRender`. |
| `styles.css` | 414 | Every style in the design — tokens, app shell, top bar, telemetry strip, panel chrome, all four body layouts, instruments, chart, controls, joysticks, switches, segmented controls, PiP, log, mission list, battery, link, and the responsive breakpoints. |
| `gauges.jsx` | 380 | React canvas components: `useCanvas` hook, `Attitude`, `AltTape`, `SpeedTape`, `HistoryChart`, `Joystick`, plus the `Readout` / `Bar` / `Lamp` primitives and the shared `GS` palette. |
| `views.jsx` | 271 | `ViewMap`, `View3D`, `ViewCam`, `MiniMap`, `Pip`, `PanelHead` and the `SHOW_DEF` view-flag defaults. |
| `panels.jsx` | 263 | `Telemetry`, `Instruments`, `EventLog`, `MissionList`, `BatteryPanel`, `LinkPanel`, `PowerPanel`, `ChartPanel`, `Switch`, and the polled-snapshot helpers. |
| `app.jsx` | 374 | `App` shell, `TopBar`, `Controls`, keyboard bindings, the four layout branches, and the Tweaks panel definition. |
| `tweaks_panel.jsx` | 773 | Unmodified starter component providing `TweaksPanel`, `useTweaks`, and the `Tweak*` controls. |

### Dependency order

```
util.js  →  sim.js  →  render.js
   (plain <script> tags, execute in this order; util.js defines window.Tick,
    which sim.js registers its fixed-step loop onto, and which every canvas
    draw loop uses)

tweaks_panel.jsx  →  gauges.jsx  →  views.jsx  →  panels.jsx  →  app.jsx
   (JSX modules. Each ends with Object.assign(window, {...}) to publish its
    components, because separate Babel script tags do not share scope.)
```

### Tweaks panel

`index.html` declares `window.TWEAK_DEFAULTS` inside an `EDITMODE-BEGIN`/`EDITMODE-END` comment block (this is the persistence contract with the host, not a design requirement). Controls exposed:

| Group | Control | Values |
|---|---|---|
| 레이아웃 | 배치 (select) | `console` / `map` / `cam` / `split` |
| 레이아웃 | 밀도 (radio) | `compact` / `standard` / `roomy` |
| 표시 | 단위 (radio) | `metric` / `imperial` |
| 표시 | 카메라 PiP (toggle) | on/off |
| 표시 | 지도 PiP (toggle) | on/off |
| 테마 | 강조색 (color) | 4 curated swatches |
| 시뮬레이션 | 시뮬 속도 (slider) | 0.25–4× |
| 시뮬레이션 | 시나리오 재생 (button) | — |

In a production build, the four layouts are the key thing to preserve; the density/units/accent switches are demonstration affordances and can be dropped or wired to real user preferences.

---

## Implementation Notes for Genspark Code / external developers

1. **Start with the four layouts.** They are the design's core idea — the same panel set rearranged for four different jobs (instrument-first, map-first, camera-first, and map+3D side by side). Get the grid definitions right and everything else slots in.
2. **Keep the accent discipline.** `#1f74d8` means "the aircraft, the current value, the active item" — nothing else. Status colours (`#1d8a5f` / `#b8791a` / `#c0392b`) are reserved for state. Do not let the accent leak into status roles or vice versa; it is the main thing that keeps a screen this dense readable.
3. **Do not lift `window.DroneSim.state` as-is.** Move it into a proper store, keep the fixed-timestep accumulator, and publish updates to React on a throttle (110–260 ms) rather than per frame.
4. **The three renderers are portable.** `render.js` has no framework dependencies beyond reading the state object. If the product needs real maps, swap `renderMap`'s terrain layer for a tile source but keep the marker/trail/FOV overlay code — that overlay is the design.
5. **Watch the tick-loop trap.** If the target environment can be a non-composited iframe or background tab, keep the rAF + watchdog pattern; a plain rAF loop will freeze the console.
6. **The PiP needs its own positioning state**, persisted per instance — do not tie it to the layout, or the user's drag will be lost on layout switch. Anchor it in CSS by default and clamp drags against the host's live pixel size (see the PiP section above) — an un-anchored absolutely-positioned PiP inside an `overflow: hidden` view renders completely invisible.
