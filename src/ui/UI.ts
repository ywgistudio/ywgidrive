import './ui.css';
import type { Settings } from '../core/Settings';
import type { CarSpec } from '../vehicle/CarSpec';
import { Tach } from './Tach';
import { Minimap } from './Minimap';

export interface HudCar {
  x: number;
  z: number;
  color: string;
  player: boolean;
}

export interface HudData {
  speed: number; // m/s
  rpm: number;
  redline: number;
  limiter: number;
  gear: number; // -1 R, 0 N, 1..n
  nitro: number; // 0..1
  boosting: boolean;
  position: number;
  total: number;
  lap: number;
  laps: number;
  raceTime: number;
  lapTime: number;
  bestLap: number | null;
  lastLap: number | null;
  cars: HudCar[];
  heading: number; // atan2(forward.x, forward.z)
  style: number;
  drift: { active: boolean; points: number; mult: number };
  wrongWay: boolean;
  gapAhead: number | null;
  gapBehind: number | null;
}

export interface ResultRow {
  position: number;
  name: string;
  car: string;
  time: number | null;
  bestLap: number | null;
  player: boolean;
}

export type UiSound = 'hover' | 'click' | 'back' | 'start';
type Dir = 'up' | 'down' | 'left' | 'right';
type ScreenName = 'none' | 'title' | 'main' | 'cars' | 'settings' | 'controls' | 'pause' | 'results';

interface Item {
  el: HTMLElement;
  activate?: () => void;
  left?: () => void;
  right?: () => void;
}

interface ScreenState {
  name: ScreenName;
  items: Item[];
  focus: number;
  horizontal: boolean; // left/right move focus instead of changing values
  onBack: (() => void) | null;
  onBrowse: ((d: -1 | 1) => void) | null; // car select left/right
  onAny: (() => void) | null; // title: any key
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function formatTime(t: number | null, digits = 3): string {
  if (t === null || !isFinite(t) || t < 0) return '--:--.' + '-'.repeat(digits);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const whole = Math.floor(s);
  const frac = Math.floor((s - whole) * 10 ** digits);
  return `${m}:${String(whole).padStart(2, '0')}.${String(frac).padStart(digits, '0')}`;
}

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
}

function hexColor(n: number): string {
  return '#' + n.toString(16).padStart(6, '0');
}

function peakPower(spec: CarSpec): { hp: number; rpm: number; torque: number } {
  const c = spec.torqueCurve;
  let best = 0;
  let bestRpm = 0;
  let torque = 0;
  for (const [, t] of c) torque = Math.max(torque, t);
  for (let rpm = c[0][0]; rpm <= spec.limiter; rpm += 50) {
    let t = c[c.length - 1][1];
    for (let i = 1; i < c.length; i++) {
      if (rpm <= c[i][0]) {
        const f = (rpm - c[i - 1][0]) / (c[i][0] - c[i - 1][0]);
        t = c[i - 1][1] + (c[i][1] - c[i - 1][1]) * f;
        break;
      }
    }
    const kw = (t * rpm) / 9549;
    if (kw > best) {
      best = kw;
      bestRpm = rpm;
    }
  }
  return { hp: Math.round(best * 1.341), rpm: bestRpm, torque: Math.round(torque) };
}

const SETTINGS_ROWS: {
  key: keyof Settings;
  label: string;
  section?: string;
  col?: 1;
  type: 'cycle' | 'slider' | 'toggle' | 'int';
  options?: { v: string | number | boolean; t: string }[];
  min?: number;
  max?: number;
}[] = [
  { key: 'quality', label: 'Graphics', section: 'Display', type: 'cycle', options: [ { v: 'low', t: 'Low' }, { v: 'medium', t: 'Medium' }, { v: 'high', t: 'High' }, { v: 'ultra', t: 'Ultra' } ] },
  { key: 'showFps', label: 'Show FPS', type: 'toggle' },
  { key: 'cameraShake', label: 'Camera shake', type: 'toggle' },
  { key: 'units', label: 'Speed units', type: 'cycle', options: [ { v: 'kmh', t: 'KM/H' }, { v: 'mph', t: 'MPH' } ] },
  { key: 'masterVolume', label: 'Master volume', section: 'Audio', type: 'slider' },
  { key: 'musicVolume', label: 'Music', type: 'slider' },
  { key: 'sfxVolume', label: 'Effects', type: 'slider' },
  { key: 'transmission', label: 'Transmission', section: 'Driving', col: 1, type: 'cycle', options: [ { v: 'auto', t: 'Automatic' }, { v: 'manual', t: 'Manual' } ] },
  { key: 'assists', label: 'Assists', type: 'cycle', options: [ { v: 'casual', t: 'Casual' }, { v: 'standard', t: 'Standard' }, { v: 'pro', t: 'Pro (off)' } ] },
  { key: 'laps', label: 'Laps', section: 'Race', type: 'int', min: 1, max: 5 },
  { key: 'opponents', label: 'Opponents', type: 'int', min: 0, max: 7 },
  { key: 'traffic', label: 'Traffic', type: 'cycle', options: [ { v: 'off', t: 'Off' }, { v: 'light', t: 'Light' }, { v: 'heavy', t: 'Heavy' } ] },
];

const BINDS: [string, string[], string[]][] = [
  ['Throttle', ['W', '↑'], ['RT']],
  ['Brake / reverse', ['S', '↓'], ['LT']],
  ['Steer', ['A', 'D', '←', '→'], ['L-Stick']],
  ['Handbrake', ['Space'], ['A']],
  ['Nitro', ['Shift', 'N'], ['X']],
  ['Shift down / up', ['Q', 'E'], ['LB', 'RB']],
  ['Change camera', ['C'], ['Y']],
  ['Look back', ['B'], ['B']],
  ['Reset to track', ['R'], ['View']],
  ['Pause', ['Esc'], ['Menu']],
  ['Mute', ['M'], []],
];

export class UI {
  onUiSound?: (kind: UiSound) => void;

  private readonly root: HTMLElement;
  private settings: Settings;

  // loading
  private readonly loadingEl: HTMLElement;
  private readonly loadFill: HTMLElement;
  private readonly loadText: HTMLElement;

  // menus
  private menuEl: HTMLElement | null = null;
  private state: ScreenState = { name: 'none', items: [], focus: 0, horizontal: false, onBack: null, onBrowse: null, onAny: null };
  private openedAt = 0;

  // hud
  private readonly hudEl: HTMLElement;
  private readonly el: Record<string, HTMLElement> = {};
  private readonly last = new Map<string, string | number | boolean>();
  private readonly tach: Tach;
  private readonly map: Minimap;
  private driftWasActive = false;
  private driftBankTimer = 0;
  private lastHudTime = 0;
  private readonly startTime = performance.now();

  constructor(root: HTMLElement, settings: Settings) {
    this.root = root;
    this.settings = { ...settings };

    // loading screen (visible immediately)
    this.loadingEl = h('div', 'ui-layer ui-loading');
    this.loadingEl.innerHTML = `
      <div class="ui-backdrop is-solid"><div class="ui-grid"></div><div class="ui-scanlines"></div></div>
      <div class="ui-logo">YWGI DRIVE<span class="ui-logo-sub">Midnight Circuit</span></div>
      <div class="ui-loadbar"><div class="ui-loadbar-fill"></div></div>
      <div class="ui-loadtext">Warming up tires</div>`;
    this.loadFill = this.loadingEl.querySelector('.ui-loadbar-fill')!;
    this.loadText = this.loadingEl.querySelector('.ui-loadtext')!;

    this.hudEl = this.buildHud();
    root.append(this.hudEl, this.loadingEl);

    this.tach = new Tach(this.el.tachCanvas as HTMLCanvasElement);
    this.map = new Minimap(this.el.mapCanvas as HTMLCanvasElement);
    const ro = new ResizeObserver(() => {
      this.tach.resize();
      this.map.resize();
    });
    ro.observe(this.el.tachCanvas);
    ro.observe(this.el.mapCanvas);
    document.fonts?.ready.then(() => this.tach.invalidate()).catch(() => {});

    window.addEventListener('keydown', this.onKey);
  }

  get menuOpen(): boolean {
    return this.state.name !== 'none';
  }

  // ───────────────────────────── loading ─────────────────────────────

  setLoading(progress: number, text?: string) {
    this.loadingEl.classList.remove('is-hidden');
    this.loadFill.style.transform = `scaleX(${Math.max(0, Math.min(1, progress))})`;
    if (text !== undefined) this.loadText.textContent = text;
  }

  hideLoading() {
    this.loadFill.style.transform = 'scaleX(1)';
    this.loadingEl.classList.add('is-hidden');
  }

  // ───────────────────────────── screens ─────────────────────────────

  showTitle(onStart: () => void) {
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      this.sound('start');
      onStart();
    };
    const m = this.openMenu('title', 'default', 'title');
    m.classList.add('ui-title-screen');
    m.insertAdjacentHTML(
      'beforeend',
      `<div class="ui-logo">YWGI DRIVE<span class="ui-logo-sub">Midnight Circuit</span></div>
       <div class="ui-press">Press any key</div>
       <div class="ui-title-meta">Street racing · realistic physics · live traffic</div>`,
    );
    m.addEventListener('pointerdown', start);
    this.state.onAny = start;
  }

  showMainMenu(hnd: { onRace: () => void; onSettings: () => void; onControls: () => void }) {
    const m = this.openMenu('main', 'default');
    const panel = h('div', 'ui-panel');
    panel.innerHTML = `<div class="ui-logo">YWGI DRIVE<span class="ui-logo-sub">Midnight Circuit</span></div>`;
    const list = h('div', 'ui-list ui-stagger');
    list.append(
      this.button('Race', 'Midnight Circuit', () => {
        this.sound('click');
        hnd.onRace();
      }, true),
      this.button('Settings', 'Graphics · audio · driving', () => {
        this.sound('click');
        hnd.onSettings();
      }),
      this.button('Controls', 'Keyboard · gamepad', () => {
        this.sound('click');
        hnd.onControls();
      }),
    );
    panel.append(list);
    m.append(panel, this.hints([['↑↓', 'Navigate'], ['Enter', 'Select']]));
    this.setFocus(0, false);
  }

  showCarSelect(cars: CarSpec[], hnd: { onSelect: (i: number) => void; onHover: (i: number) => void; onBack: () => void }, initial = 0) {
    const m = this.openMenu('cars', 'clear', 'none');
    let idx = Math.max(0, Math.min(cars.length - 1, initial));

    const info = h('div', 'ui-carsel-info');
    info.innerHTML = `
      <div class="ui-carsel-index"></div>
      <div class="ui-carsel-name"></div>
      <div class="ui-carsel-tag"></div>
      <div class="ui-specs"></div>
      <div class="ui-stats"></div>`;
    const idxEl = info.querySelector('.ui-carsel-index') as HTMLElement;
    const nameEl = info.querySelector('.ui-carsel-name') as HTMLElement;
    const tagEl = info.querySelector('.ui-carsel-tag') as HTMLElement;
    const specsEl = info.querySelector('.ui-specs') as HTMLElement;
    const statsEl = info.querySelector('.ui-stats') as HTMLElement;
    const statDefs: [keyof CarSpec['stats'], string][] = [
      ['power', 'Power'],
      ['grip', 'Grip'],
      ['weight', 'Weight'],
      ['drift', 'Drift'],
    ];
    const fills: HTMLElement[] = [];
    for (const [, label] of statDefs) {
      const row = h('div', 'ui-stat');
      row.innerHTML = `<div class="ui-stat-label">${label}</div><div class="ui-stat-bar"><div class="ui-stat-fill"></div></div>`;
      fills.push(row.querySelector('.ui-stat-fill') as HTMLElement);
      statsEl.append(row);
    }

    const arrows = h('div', 'ui-carsel-arrows');
    const left = h('button', 'ui-arrow ui-carsel-left', '‹');
    const right = h('button', 'ui-arrow', '›');
    arrows.append(left, right);

    const dots = h('div', 'ui-carsel-dots');
    for (let i = 0; i < cars.length; i++) dots.append(h('i'));

    const actions = h('div', 'ui-carsel-actions');
    actions.append(
      this.button('Select', 'Start race', () => {
        this.sound('start');
        hnd.onSelect(idx);
      }, true),
      this.button('Back', undefined, () => this.back(), false, true),
    );

    const render = (dir: number) => {
      const spec = cars[idx];
      const p = peakPower(spec);
      idxEl.innerHTML = `<span class="ui-swatch" style="color:${hexColor(spec.paint)};background:${hexColor(spec.paint)}"></span><b>${String(idx + 1).padStart(2, '0')}</b> / ${String(cars.length).padStart(2, '0')}`;
      nameEl.textContent = spec.name;
      tagEl.textContent = spec.tagline;
      specsEl.innerHTML = [
        ['Power', `${p.hp}<small>HP</small>`],
        ['Torque', `${p.torque}<small>NM</small>`],
        ['Weight', `${spec.mass.toLocaleString('en-US')}<small>KG</small>`],
        ['Drive', spec.drive],
        ['Redline', `${(spec.redline / 1000).toFixed(1)}<small>K</small>`],
        ['Gears', `${spec.gears.length}<small>SPD</small>`],
      ]
        .map(([l, v]) => `<div class="ui-spec"><div class="ui-spec-label">${l}</div><div class="ui-spec-val">${v}</div></div>`)
        .join('');
      statDefs.forEach(([k], i) => {
        fills[i].style.transform = `scaleX(${Math.max(0.04, Math.min(1, spec.stats[k]))})`;
      });
      dots.querySelectorAll('i').forEach((d, i) => d.classList.toggle('is-on', i === idx));
      if (dir !== 0) {
        for (const el of [nameEl, tagEl, specsEl]) {
          el.animate(
            [
              { opacity: 0, transform: `${el === nameEl ? 'skewX(-12deg) ' : ''}translateX(${dir * 26}px)` },
              { opacity: 1, transform: `${el === nameEl ? 'skewX(-12deg) ' : ''}translateX(0)` },
            ],
            { duration: 320, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
          );
        }
      }
    };

    const browse = (d: -1 | 1) => {
      if (cars.length < 2) return;
      idx = (idx + d + cars.length) % cars.length;
      const arrow = d < 0 ? left : right;
      arrow.classList.add('is-bump');
      setTimeout(() => arrow.classList.remove('is-bump'), 120);
      this.sound('hover');
      render(d);
      hnd.onHover(idx);
    };
    left.addEventListener('click', () => browse(-1));
    right.addEventListener('click', () => browse(1));

    m.append(info, arrows, dots, actions, this.hints([['←→', 'Browse'], ['Enter', 'Select'], ['Esc', 'Back']]));
    this.state.onBrowse = browse;
    this.state.onBack = () => {
      this.sound('back');
      hnd.onBack();
    };
    render(0);
    hnd.onHover(idx);
    this.setFocus(0, false);
  }

  showSettings(s: Settings, onChange: (s: Settings) => void, onBack: () => void) {
    const m = this.openMenu('settings', 'default');
    const cur: Settings = { ...s };
    const panel = h('div', 'ui-panel is-settings');
    panel.innerHTML = `<div class="ui-kicker">Options</div><div class="ui-title">Settings</div>`;
    const cols = h('div', 'ui-cols');
    const colEls = [h('div', 'ui-list ui-stagger'), h('div', 'ui-list ui-stagger')];
    cols.append(...colEls);
    const emit = () => {
      this.settings = { ...cur };
      onChange({ ...cur });
    };

    let col = 0;
    for (const row of SETTINGS_ROWS) {
      if (row.col) col = 1;
      const list = colEls[col];
      if (row.section) list.append(h('div', 'ui-section', esc(row.section)));
      const el = h('button', 'ui-btn ui-opt is-small');
      const label = h('span', '', esc(row.label));
      const value = h('span', 'ui-opt-value');
      el.append(label, value);
      const key = row.key;
      const paint = () => {
        const v = cur[key];
        if (row.type === 'slider') {
          const pct = Math.round((v as number) * 100);
          value.innerHTML = `<span class="ui-opt-arrow" data-d="-1">‹</span><span class="ui-slider"><span class="ui-slider-fill" style="transform:scaleX(${(v as number).toFixed(2)})"></span></span><span class="ui-slider-num">${pct}%</span><span class="ui-opt-arrow" data-d="1">›</span>`;
        } else if (row.type === 'toggle') {
          value.innerHTML = `<span class="ui-opt-arrow" data-d="-1">‹</span><span class="ui-opt-val-text">${v ? 'On' : 'Off'}</span><span class="ui-opt-arrow" data-d="1">›</span>`;
        } else if (row.type === 'int') {
          value.innerHTML = `<span class="ui-opt-arrow" data-d="-1">‹</span><span class="ui-opt-val-text">${v}</span><span class="ui-opt-arrow" data-d="1">›</span>`;
        } else {
          const opt = row.options!.find((o) => o.v === v) ?? row.options![0];
          value.innerHTML = `<span class="ui-opt-arrow" data-d="-1">‹</span><span class="ui-opt-val-text">${esc(opt.t)}</span><span class="ui-opt-arrow" data-d="1">›</span>`;
        }
      };
      const change = (d: -1 | 1) => {
        const rec = cur as unknown as Record<string, unknown>;
        if (row.type === 'slider') {
          rec[key] = Math.round(Math.max(0, Math.min(1, (cur[key] as number) + d * 0.1)) * 10) / 10;
        } else if (row.type === 'toggle') {
          rec[key] = !cur[key];
        } else if (row.type === 'int') {
          const v = (cur[key] as number) + d;
          rec[key] = Math.max(row.min!, Math.min(row.max!, v));
        } else {
          const opts = row.options!;
          const i = Math.max(0, opts.findIndex((o) => o.v === cur[key]));
          rec[key] = opts[(i + d + opts.length) % opts.length].v;
        }
        paint();
        this.sound('hover');
        emit();
      };
      paint();
      const item = this.addItem(el, { activate: () => change(1), left: () => change(-1), right: () => change(1) }, false);
      // arrows inside the value are clickable on their own
      el.addEventListener('click', (ev) => {
        const t = ev.target as HTMLElement;
        const arrow = t.closest('.ui-opt-arrow') as HTMLElement | null;
        ev.stopImmediatePropagation();
        this.setFocus(this.state.items.indexOf(item), false);
        change(arrow && arrow.dataset.d === '-1' ? -1 : 1);
      }, true);
      list.append(el);
    }
    const backList = h('div', 'ui-list');
    backList.append(this.button('Back', undefined, () => this.back(), false, true));
    panel.append(cols, backList);
    m.append(panel, this.hints([['↑↓', 'Navigate'], ['←→', 'Change'], ['Esc', 'Back']]));
    this.state.onBack = () => {
      this.sound('back');
      onBack();
    };
    this.setFocus(0, false);
  }

  showControls(onBack: () => void) {
    const m = this.openMenu('controls', 'default');
    const panel = h('div', 'ui-panel is-wide');
    panel.innerHTML = `<div class="ui-kicker">How to drive</div><div class="ui-title">Controls</div>`;
    const grid = h('div', 'ui-binds');
    grid.innerHTML =
      `<div class="ui-binds-h">Action</div><div class="ui-binds-h">Keyboard</div><div class="ui-binds-h">Gamepad</div>` +
      BINDS.map(
        ([a, k, g]) =>
          `<div>${esc(a)}</div><div>${k.map((x) => `<span class="ui-key">${esc(x)}</span>`).join('')}</div><div>${g.length ? g.map((x) => `<span class="ui-key">${esc(x)}</span>`).join('') : '<span style="color:var(--dim)">—</span>'}</div>`,
      ).join('');
    const list = h('div', 'ui-list');
    list.append(this.button('Back', undefined, () => this.back(), false, true));
    panel.append(grid, list);
    m.append(panel, this.hints([['Esc', 'Back']]));
    this.state.onBack = () => {
      this.sound('back');
      onBack();
    };
    this.setFocus(0, false);
  }

  showPause(hnd: { onResume: () => void; onRestart: () => void; onSettings: () => void; onQuit: () => void }) {
    const m = this.openMenu('pause', 'default', 'none');
    const panel = h('div', 'ui-panel');
    panel.innerHTML = `<div class="ui-kicker">Race on hold</div><div class="ui-title">Paused</div>`;
    const list = h('div', 'ui-list ui-stagger');
    list.append(
      this.button('Resume', undefined, () => {
        this.sound('click');
        hnd.onResume();
      }, true),
      this.button('Restart race', undefined, () => {
        this.sound('click');
        hnd.onRestart();
      }),
      this.button('Settings', undefined, () => {
        this.sound('click');
        hnd.onSettings();
      }),
      this.button('Quit to menu', undefined, () => {
        this.sound('click');
        hnd.onQuit();
      }),
    );
    panel.append(list);
    m.append(panel, this.hints([['↑↓', 'Navigate'], ['Enter', 'Select'], ['Esc', 'Resume']]));
    this.state.onBack = () => {
      this.sound('back');
      hnd.onResume();
    };
    this.setFocus(0, false);
  }

  showResults(rows: ResultRow[], stats: { style: number; topSpeed: number; drift: number; nearMisses: number }, hnd: { onRestart: () => void; onMenu: () => void }) {
    const m = this.openMenu('results', 'default', 'none');
    this.state.horizontal = true;
    const player = rows.find((r) => r.player);
    const wrap = h('div', 'ui-results');
    const place = player ? `${player.position}<small>${ordinal(player.position)}</small>` : '—';
    const verdict = !player ? 'Race over' : player.position === 1 ? 'Victory' : player.position <= 3 ? 'Podium finish' : 'Race complete';
    const kmh = this.settings.units === 'mph' ? stats.topSpeed * 2.23694 : stats.topSpeed * 3.6;
    wrap.innerHTML = `
      <div class="ui-results-head">
        <div><div class="ui-kicker">${esc(verdict)}</div><div class="ui-title" style="margin-bottom:0">Results</div></div>
        <div class="ui-results-place">${place}</div>
      </div>
      <table class="ui-table">
        <thead><tr><th>Pos</th><th>Driver</th><th class="hide-sm">Car</th><th>Time</th><th class="hide-sm">Best lap</th></tr></thead>
        <tbody>${[...rows]
          .sort((a, b) => a.position - b.position)
          .map(
            (r) =>
              `<tr class="${r.player ? 'is-player' : ''} ${r.position === 1 ? 'is-first' : ''}"><td class="pos">${r.position}</td><td>${esc(r.name)}</td><td class="hide-sm">${esc(r.car)}</td><td class="num">${r.time === null ? 'DNF' : formatTime(r.time)}</td><td class="num hide-sm">${formatTime(r.bestLap)}</td></tr>`,
          )
          .join('')}</tbody>
      </table>
      <div class="ui-results-stats">
        <div><div class="hud-label">Style</div><div class="ui-spec-val">${Math.round(stats.style).toLocaleString('en-US')}<small>PTS</small></div></div>
        <div><div class="hud-label">Top speed</div><div class="ui-spec-val">${Math.round(kmh)}<small>${this.settings.units === 'mph' ? 'MPH' : 'KM/H'}</small></div></div>
        <div><div class="hud-label">Drift</div><div class="ui-spec-val">${Math.round(stats.drift).toLocaleString('en-US')}<small>PTS</small></div></div>
        <div><div class="hud-label">Near misses</div><div class="ui-spec-val">${stats.nearMisses}</div></div>
      </div>`;
    const actions = h('div', 'ui-results-actions');
    actions.append(
      this.button('Race again', undefined, () => {
        this.sound('start');
        hnd.onRestart();
      }, true),
      this.button('Main menu', undefined, () => {
        this.sound('click');
        hnd.onMenu();
      }),
    );
    wrap.append(actions);
    m.append(wrap, this.hints([['←→', 'Navigate'], ['Enter', 'Select']]));
    this.setFocus(0, false);
  }

  hideMenus() {
    this.closeMenu();
    this.state = { name: 'none', items: [], focus: 0, horizontal: false, onBack: null, onBrowse: null, onAny: null };
  }

  // ───────────────────────────── navigation ─────────────────────────────

  navigate(dir: Dir) {
    const st = this.state;
    if (st.name === 'none') return;
    if (st.name === 'title') {
      st.onAny?.();
      return;
    }
    if ((dir === 'left' || dir === 'right') && st.onBrowse) {
      st.onBrowse(dir === 'left' ? -1 : 1);
      return;
    }
    const n = st.items.length;
    if (!n) return;
    const prevNext = st.horizontal ? (dir === 'left' ? -1 : dir === 'right' ? 1 : 0) : dir === 'up' ? -1 : dir === 'down' ? 1 : 0;
    if (prevNext !== 0) {
      this.setFocus((st.focus + prevNext + n) % n, true);
      return;
    }
    const item = st.items[st.focus];
    if (dir === 'left') item.left?.();
    else if (dir === 'right') item.right?.();
    else if (st.horizontal) this.setFocus((st.focus + (dir === 'up' ? -1 : 1) + n) % n, true);
  }

  confirm() {
    const st = this.state;
    if (st.name === 'none') return;
    if (st.name === 'title') {
      st.onAny?.();
      return;
    }
    st.items[st.focus]?.activate?.();
  }

  back() {
    const st = this.state;
    if (st.name === 'title') {
      st.onAny?.();
      return;
    }
    st.onBack?.();
  }

  private onKey = (e: KeyboardEvent) => {
    if (this.state.name === 'none') return;
    // ignore the very keypress that opened this menu (e.g. Esc that triggered pause)
    if (e.timeStamp && e.timeStamp < this.openedAt) return;
    if (this.state.name === 'title') {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      this.state.onAny?.();
      return;
    }
    let handled = true;
    switch (e.code) {
      case 'ArrowUp':
      case 'KeyW':
        this.navigate('up');
        break;
      case 'ArrowDown':
      case 'KeyS':
        this.navigate('down');
        break;
      case 'ArrowLeft':
      case 'KeyA':
        this.navigate('left');
        break;
      case 'ArrowRight':
      case 'KeyD':
        this.navigate('right');
        break;
      case 'Enter':
      case 'NumpadEnter':
      case 'Space':
        if (!e.repeat) this.confirm();
        break;
      case 'Escape':
      case 'Backspace':
        if (!e.repeat) this.back();
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // ───────────────────────────── HUD ─────────────────────────────

  showHud(on: boolean) {
    this.hudEl.classList.toggle('is-on', on);
    if (on) {
      requestAnimationFrame(() => {
        this.tach.resize();
        this.map.resize();
      });
    }
  }

  setMinimapTrack(points: { x: number; z: number }[], startIndex = 0) {
    this.map.setTrack(points, startIndex);
  }

  updateHud(d: HudData) {
    const now = performance.now();
    const dt = Math.min(0.1, (now - (this.lastHudTime || now)) / 1000);
    this.lastHudTime = now;
    const t = (now - this.startTime) / 1000;

    // speed / gear
    const mph = this.settings.units === 'mph';
    const spd = Math.round(Math.abs(d.speed) * (mph ? 2.23694 : 3.6));
    this.text('speed', String(spd));
    this.text('unit', mph ? 'MPH' : 'KM/H');
    this.text('gear', d.gear < 0 ? 'R' : d.gear === 0 ? 'N' : String(d.gear));
    this.cls('gear', 'is-shift', d.gear > 0 && d.rpm >= d.redline * 0.97);
    this.cls('gear', 'is-rev', d.gear < 0);

    // nitro
    const nitro = Math.max(0, Math.min(1, d.nitro));
    const nq = Math.round(nitro * 200) / 200;
    if (this.last.get('nitro') !== nq) {
      this.last.set('nitro', nq);
      this.el.nitroFill.style.transform = `scaleX(${nq})`;
    }
    this.cls('nitro', 'is-boost', d.boosting);
    this.cls('nitro', 'is-full', nitro >= 0.995 && !d.boosting);

    // position / lap
    this.text('posNum', String(d.position));
    this.text('posSfx', ordinal(d.position));
    this.text('posTotal', `/${d.total}`);
    this.cls('posNum', 'is-first', d.position === 1);
    this.html('lap', `${Math.min(d.lap, d.laps)}<small>/${d.laps}</small>`);
    this.gap('gapAhead', d.gapAhead, '+');
    this.gap('gapBehind', d.gapBehind, '−');

    // times
    this.text('time', formatTime(d.raceTime, 2));
    this.text('lapTime', formatTime(d.lapTime));
    this.text('bestLap', formatTime(d.bestLap));
    this.text('lastLap', formatTime(d.lastLap));
    this.cls('lastLap', 'is-best', d.lastLap !== null && d.bestLap !== null && Math.abs(d.lastLap - d.bestLap) < 1e-6);

    // style + drift combo
    this.text('style', Math.round(d.style).toLocaleString('en-US'));
    if (d.drift.active) {
      this.driftWasActive = true;
      this.driftBankTimer = 0;
      this.text('driftPts', Math.round(d.drift.points).toLocaleString('en-US'));
      this.text('driftMult', `×${d.drift.mult}`);
      this.cls('drift', 'is-on', true);
      this.cls('drift', 'is-banked', false);
    } else if (this.driftWasActive) {
      this.driftWasActive = false;
      this.driftBankTimer = 1.3;
      this.cls('drift', 'is-banked', true);
    } else if (this.driftBankTimer > 0) {
      this.driftBankTimer -= dt;
      if (this.driftBankTimer <= 0) {
        this.cls('drift', 'is-on', false);
        this.cls('drift', 'is-banked', false);
      }
    }

    this.cls('wrong', 'is-on', d.wrongWay);

    // canvases
    this.tach.draw(d.rpm, d.redline, d.limiter, t);
    this.map.draw(d.cars, d.heading);
  }

  countdown(step: 3 | 2 | 1 | 0) {
    const el = this.el.count;
    const span = el.firstElementChild as HTMLElement;
    span.textContent = step === 0 ? 'GO!' : String(step);
    el.classList.toggle('is-go', step === 0);
    el.getAnimations().forEach((a) => a.cancel());
    el.animate(
      step === 0
        ? [
            { opacity: 0, transform: 'scale(0.6)', filter: 'blur(10px)' },
            { opacity: 1, transform: 'scale(1.08)', filter: 'blur(0px)', offset: 0.15 },
            { opacity: 1, transform: 'scale(1)', offset: 0.6 },
            { opacity: 0, transform: 'scale(1.6)', filter: 'blur(6px)' },
          ]
        : [
            { opacity: 0, transform: 'scale(1.9)', filter: 'blur(14px)' },
            { opacity: 1, transform: 'scale(1)', filter: 'blur(0px)', offset: 0.22 },
            { opacity: 1, transform: 'scale(0.94)', offset: 0.7 },
            { opacity: 0, transform: 'scale(0.7)', filter: 'blur(4px)' },
          ],
      { duration: step === 0 ? 1100 : 950, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' },
    );
  }

  popup(title: string, sub?: string, color = '#ff2bd6') {
    const box = this.el.popups;
    const p = h('div', 'hud-popup');
    p.style.setProperty('--c', color);
    p.innerHTML = `<b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}`;
    box.prepend(p);
    while (box.children.length > 5) box.lastElementChild!.remove();
    const a = p.animate(
      [
        { opacity: 0, transform: 'skewX(-12deg) translateX(60px)' },
        { opacity: 1, transform: 'skewX(-12deg) translateX(-6px)', offset: 0.1 },
        { opacity: 1, transform: 'skewX(-12deg) translateX(0)', offset: 0.18 },
        { opacity: 1, transform: 'skewX(-12deg) translateX(0)', offset: 0.82 },
        { opacity: 0, transform: 'skewX(-12deg) translateX(30px)' },
      ],
      { duration: 2000, easing: 'ease-out', fill: 'forwards' },
    );
    a.onfinish = () => p.remove();
  }

  flash(text: string, ms = 1600, color = '#f2f4ff') {
    const el = this.el.flash;
    el.textContent = text;
    el.style.color = color;
    el.getAnimations().forEach((a) => a.cancel());
    el.animate(
      [
        { opacity: 0, transform: 'skewX(-12deg) scale(1.25)', letterSpacing: '0.4em' },
        { opacity: 1, transform: 'skewX(-12deg) scale(1)', letterSpacing: '0.08em', offset: Math.min(0.3, 250 / ms) },
        { opacity: 1, transform: 'skewX(-12deg) scale(1)', offset: Math.max(0.5, 1 - 300 / ms) },
        { opacity: 0, transform: 'skewX(-12deg) scale(0.96)' },
      ],
      { duration: ms, easing: 'ease-out', fill: 'forwards' },
    );
  }

  setFps(fps: number | null) {
    const el = this.el.fps;
    if (fps === null) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    this.text('fps', `${Math.round(fps)} FPS`);
  }

  // ───────────────────────────── internals ─────────────────────────────

  private sound(kind: UiSound) {
    try {
      this.onUiSound?.(kind);
    } catch {
      /* audio is optional */
    }
  }

  private openMenu(name: ScreenName, backdrop: 'default' | 'clear' | 'solid', streaks: 'right' | 'title' | 'none' = 'right'): HTMLElement {
    this.closeMenu();
    const m = h('div', 'ui-layer ui-menu');
    const bd = h('div', `ui-backdrop streaks-${streaks}${backdrop === 'clear' ? ' is-clear' : backdrop === 'solid' ? ' is-solid' : ''}`);
    bd.innerHTML = `<div class="ui-grid"></div><div class="ui-streaks"><i></i><i></i><i></i><i></i><i></i><i></i></div><div class="ui-scanlines"></div>`;
    m.append(bd);
    this.root.insertBefore(m, this.loadingEl);
    this.menuEl = m;
    this.state = { name, items: [], focus: 0, horizontal: false, onBack: null, onBrowse: null, onAny: null };
    this.openedAt = performance.now();
    return m;
  }

  private closeMenu() {
    const old = this.menuEl;
    if (!old) return;
    this.menuEl = null;
    old.classList.add('is-leaving');
    setTimeout(() => old.remove(), 200);
  }

  private hints(list: [string, string][]): HTMLElement {
    const el = h('div', 'ui-hints');
    el.innerHTML = list.map(([k, t]) => `<span><kbd>${esc(k)}</kbd>${esc(t)}</span>`).join('');
    return el;
  }

  private button(label: string, sub: string | undefined, onClick: () => void, primary = false, small = false): HTMLElement {
    const el = h('button', `ui-btn${primary ? ' is-primary' : ''}${small ? ' is-small' : ''}`);
    el.type = 'button';
    el.innerHTML = `<span>${esc(label)}</span>${sub ? `<span class="ui-btn-sub">${esc(sub)}</span>` : ''}`;
    this.addItem(el, { activate: onClick }, true);
    return el;
  }

  private addItem(el: HTMLElement, opts: Omit<Item, 'el'>, clickActivates: boolean): Item {
    const item: Item = { el, ...opts };
    const list = this.state.items;
    list.push(item);
    el.tabIndex = -1;
    el.addEventListener('mouseenter', () => {
      const i = this.state.items.indexOf(item);
      if (i >= 0 && i !== this.state.focus) this.setFocus(i, true);
    });
    if (clickActivates) {
      el.addEventListener('click', () => {
        const i = this.state.items.indexOf(item);
        if (i >= 0) this.setFocus(i, false);
        item.activate?.();
      });
    }
    return item;
  }

  private setFocus(i: number, withSound: boolean) {
    const st = this.state;
    st.items[st.focus]?.el.classList.remove('is-focused');
    st.focus = i;
    const it = st.items[i];
    if (!it) return;
    it.el.classList.add('is-focused');
    it.el.scrollIntoView?.({ block: 'nearest' });
    if (withSound) this.sound('hover');
  }

  private text(key: string, v: string) {
    if (this.last.get(key) === v) return;
    this.last.set(key, v);
    this.el[key].textContent = v;
  }

  private html(key: string, v: string) {
    if (this.last.get(key) === v) return;
    this.last.set(key, v);
    this.el[key].innerHTML = v;
  }

  private cls(key: string, c: string, on: boolean) {
    const k = `${key}.${c}`;
    if (this.last.get(k) === on) return;
    this.last.set(k, on);
    this.el[key].classList.toggle(c, on);
  }

  private gap(key: string, v: number | null, sign: string) {
    const el = this.el[key];
    const shown = v !== null && isFinite(v);
    this.cls(key, 'is-hidden-gap', !shown);
    if (this.last.get(key + '.vis') !== shown) {
      this.last.set(key + '.vis', shown);
      el.style.opacity = shown ? '1' : '0';
    }
    if (shown) this.text(key + 'Val', `${sign}${Math.abs(v!).toFixed(2)}s`);
  }

  private buildHud(): HTMLElement {
    const hud = h('div', 'ui-layer ui-hud');
    hud.innerHTML = `
      <div class="hud-tl">
        <div class="hud-pos"><span class="hud-pos-num" data-k="posNum">1</span><span class="hud-pos-sfx" data-k="posSfx">st</span><span class="hud-pos-total" data-k="posTotal">/6</span></div>
        <div class="hud-lap hud-glass"><span class="hud-label">Lap</span><span class="hud-lap-val" data-k="lap">1<small>/3</small></span></div>
        <div class="hud-gaps">
          <div class="hud-gap is-ahead" data-k="gapAhead"><span>Ahead</span><b data-k="gapAheadVal">+0.00s</b></div>
          <div class="hud-gap is-behind" data-k="gapBehind"><span>Behind</span><b data-k="gapBehindVal">−0.00s</b></div>
        </div>
      </div>
      <div class="hud-style"><span class="hud-label">Style</span><b data-k="style">0</b></div>
      <div class="hud-drift" data-k="drift">
        <div class="hud-drift-row"><span class="hud-drift-title">Drift</span><span class="hud-drift-mult" data-k="driftMult">×1</span></div>
        <div class="hud-drift-pts" data-k="driftPts">0</div>
      </div>
      <div class="hud-tr">
        <div class="hud-fps" data-k="fps" style="display:none"></div>
        <div class="hud-time" data-k="time">0:00.00</div>
        <div class="hud-times hud-glass">
          <span class="hud-label">Lap</span><b data-k="lapTime">0:00.000</b>
          <span class="hud-label">Best</span><b class="is-best" data-k="bestLap">--:--.---</b>
          <span class="hud-label">Last</span><b data-k="lastLap">--:--.---</b>
        </div>
      </div>
      <div class="hud-popups" data-k="popups"></div>
      <div class="hud-count" data-k="count"><span></span></div>
      <div class="hud-center">
        <div class="hud-flash" data-k="flash"></div>
        <div class="hud-wrong" data-k="wrong">Wrong way</div>
      </div>
      <div class="hud-bl">
        <div class="hud-map"><canvas data-k="mapCanvas"></canvas></div>
        <div class="hud-map-ring"></div>
      </div>
      <div class="hud-br">
        <div class="hud-tach">
          <canvas data-k="tachCanvas"></canvas>
          <div class="hud-speed"><span class="hud-speed-num" data-k="speed">0</span><span class="hud-speed-unit" data-k="unit">KM/H</span></div>
          <div class="hud-gear" data-k="gear">N</div>
        </div>
        <div class="hud-nitro hud-glass" data-k="nitro">
          <span class="hud-nitro-label">N₂O</span>
          <div class="hud-nitro-track"><div class="hud-nitro-fill" data-k="nitroFill"></div></div>
        </div>
      </div>`;
    hud.querySelectorAll<HTMLElement>('[data-k]').forEach((el) => {
      this.el[el.dataset.k!] = el;
    });
    return hud;
  }
}
