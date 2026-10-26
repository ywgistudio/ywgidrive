// Dev harness for the UI: /src/ui/dev.html?state=title|main|cars|settings|controls|pause|results|hud|loading[&bright]
import { UI, type HudData } from './UI';
import { CARS } from '../vehicle/CarSpec';
import { DEFAULT_SETTINGS } from '../core/Settings';
import { Track } from '../track/Track';
import { TouchControls } from './TouchControls';
import { Input } from '../core/Input';

const params = new URLSearchParams(location.search);
const state = params.get('state') ?? 'title';
if (params.has('bright')) document.body.classList.add('bright');

const settings = { ...DEFAULT_SETTINGS };
const ui = new UI(document.getElementById('ui')!, settings);
ui.onUiSound = (k) => console.log('sound', k);
(window as unknown as { ui: UI }).ui = ui;

const noop = () => {};
if (state === 'loading') {
  ui.setLoading(0.62, 'Building the city');
} else {
  ui.hideLoading();
}

const track = new Track();
const pts: { x: number; z: number }[] = [];
for (let i = 0; i < track.count; i++) pts.push({ x: track.px[i], z: track.pz[i] });
ui.setMinimapTrack(pts, Math.floor(186 / track.step));

const menus = () => ui.showMainMenu({ onRace: () => cars(), onDrunk: () => cars(), onSettings: () => sett(), onControls: () => ctrl() });
const cars = () => ui.showCarSelect(CARS, { onSelect: (i) => console.log('select', i), onHover: (i) => console.log('hover', i), onBack: menus });
const sett = () => ui.showSettings(settings, (s) => Object.assign(settings, s), menus);
const ctrl = () => ui.showControls(menus);

switch (state) {
  case 'title':
    ui.showTitle(menus);
    break;
  case 'main':
    menus();
    break;
  case 'cars':
    cars();
    break;
  case 'settings':
    sett();
    break;
  case 'controls':
    ctrl();
    break;
  case 'pause':
    ui.showHud(true);
    ui.showPause({ onResume: () => ui.hideMenus(), onRestart: noop, onSettings: sett, onQuit: menus });
    break;
  case 'results':
    ui.showResults(
      [
        { position: 1, name: 'NOX', car: 'STUTTGART TURBO S', time: 274.532, bestLap: 89.112, player: false },
        { position: 2, name: 'YOU', car: 'BAVARIA CSL', time: 275.901, bestLap: 88.874, player: true },
        { position: 3, name: 'VIPER', car: 'BAVARIA CSL', time: 278.33, bestLap: 90.02, player: false },
        { position: 4, name: 'KAITO', car: 'BAVARIA E30 EVO', time: 280.1, bestLap: 91.4, player: false },
        { position: 5, name: 'JUNO', car: 'STUTTGART 930 WIDOWMAKER', time: 284.77, bestLap: 92.33, player: false },
        { position: 6, name: 'RAZE', car: 'BAVARIA CSL', time: null, bestLap: 93.1, player: false },
      ],
      { style: 18450, topSpeed: 86.4, drift: 9120, nearMisses: 14 },
      { onRestart: noop, onMenu: menus },
    );
    break;
}

if (params.has('touch')) new TouchControls(document.getElementById('ui')!, new Input()).show(true);

if (state === 'hud' || state === 'pause') {
  ui.showHud(true);
  ui.setFps(params.has('fps') ? 60 : null);
  if (params.has('drunk')) ui.setDrunk(Number(params.get('drunk') || 0.6));
  const t0 = performance.now();
  let popped = false;
  const loop = () => {
    const t = (performance.now() - t0) / 1000;
    const fixed = params.has('still');
    const tt = fixed ? 2.4 : t;
    const cycle = (tt * 0.45) % 1;
    const rpm = 2500 + cycle * 4800;
    const i = Math.floor(((tt * 40) / track.step) % track.count);
    const j = (i + 3) % track.count;
    const heading = Math.atan2(track.px[j] - track.px[i], track.pz[j] - track.pz[i]);
    const cars = [
      { x: track.px[i], z: track.pz[i], color: '#fff', player: true },
      { x: track.px[(i + 30) % track.count], z: track.pz[(i + 30) % track.count], color: '#ff3355', player: false },
      { x: track.px[(i + 80) % track.count], z: track.pz[(i + 80) % track.count], color: '#3dffa8', player: false },
      { x: track.px[(i + 600) % track.count], z: track.pz[(i + 600) % track.count], color: '#ffb020', player: false },
      { x: track.px[(i + track.count - 20) % track.count], z: track.pz[(i + track.count - 20) % track.count], color: '#8a5cff', player: false },
    ];
    const d: HudData = {
      speed: 30 + cycle * 45,
      rpm,
      redline: 7100,
      limiter: 7300,
      gear: 3 + Math.floor(tt / 2.2) % 3,
      nitro: 0.35 + 0.6 * Math.abs(Math.sin(tt * 0.3)),
      boosting: params.has('boost') || (Math.floor(tt) % 5 === 3),
      position: 2,
      total: 6,
      lap: 2,
      laps: 3,
      raceTime: 92.37 + tt,
      lapTime: 21.4 + tt,
      bestLap: 69.874,
      lastLap: 70.452,
      cars,
      heading,
      style: 12840 + tt * 120,
      drift: { active: params.has('drift') || tt % 6 < 3, points: 1850 + tt * 200, mult: 3 },
      wrongWay: params.has('wrong'),
      gapAhead: 1.24,
      gapBehind: 0.81,
    };
    ui.updateHud(d);
    if (!popped && t > 0.3) {
      popped = true;
      ui.popup('NEAR MISS', '+250', '#ffe14d');
      ui.popup('GREAT DRIFT', '+1,850  x3', '#ff3df2');
      ui.popup('SLIPSTREAM', '+150', '#9dff6a');
      if (params.has('flash')) ui.flash('FINAL LAP', 4000, '#ffb020');
      if (params.has('count')) ui.countdown(2);
    }
    requestAnimationFrame(loop);
  };
  loop();
}
