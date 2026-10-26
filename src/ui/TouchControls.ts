import type { Input } from '../core/Input';

export function isTouchDevice(): boolean {
  return (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches) || 'ontouchstart' in window || navigator.maxTouchPoints > 1;
}

/**
 * On-screen driving controls for phones/tablets: a drag-to-steer zone under the left thumb,
 * gas/brake pedals plus nitro and drift buttons under the right thumb, and small pause/camera/reset keys.
 * Writes into Input.touch, which Input merges with keyboard/gamepad.
 */
export class TouchControls {
  private root: HTMLDivElement;
  private knob: HTMLDivElement;
  private steerId = -1;
  private steerX0 = 0;
  private rotate: HTMLDivElement;
  onPause?: () => void;
  onCamera?: () => void;
  onReset?: () => void;

  constructor(parent: HTMLElement, private input: Input) {
    document.body.classList.add('is-touch');
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.className = 'tc';
    this.root.innerHTML = `
      <div class="tc-steer"><div class="tc-track"><span>‹</span><span>›</span></div><div class="tc-knob"></div><div class="tc-hint">DRAG TO STEER</div></div>
      <button class="tc-btn tc-brake" data-k="brake">BRAKE</button>
      <button class="tc-btn tc-gas" data-k="gas">GAS</button>
      <button class="tc-btn tc-round tc-nitro" data-k="nitro">N₂O</button>
      <button class="tc-btn tc-round tc-drift" data-k="drift">DRIFT</button>
      <div class="tc-top">
        <button class="tc-mini" data-k="pause">❚❚</button>
        <button class="tc-mini" data-k="camera">CAM</button>
        <button class="tc-mini" data-k="reset">RESET</button>
      </div>`;
    parent.appendChild(this.root);
    this.knob = this.root.querySelector('.tc-knob') as HTMLDivElement;

    this.rotate = document.createElement('div');
    this.rotate.className = 'tc-rotate';
    this.rotate.innerHTML = '<div>↻</div><p>Rotate your phone to landscape</p>';
    parent.appendChild(this.rotate);

    const steer = this.root.querySelector('.tc-steer') as HTMLDivElement;
    steer.addEventListener('pointerdown', (e) => {
      if (this.steerId !== -1) return;
      this.steerId = e.pointerId;
      this.steerX0 = e.clientX;
      steer.setPointerCapture(e.pointerId);
      this.setSteer(0);
      steer.classList.add('is-active');
      e.preventDefault();
    });
    steer.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.steerId) return;
      const range = Math.max(50, Math.min(110, window.innerWidth * 0.08));
      const raw = Math.max(-1, Math.min(1, (e.clientX - this.steerX0) / range));
      this.setSteer(raw);
      e.preventDefault();
    });
    const endSteer = (e: PointerEvent) => {
      if (e.pointerId !== this.steerId) return;
      this.steerId = -1;
      this.setSteer(0);
      steer.classList.remove('is-active');
    };
    steer.addEventListener('pointerup', endSteer);
    steer.addEventListener('pointercancel', endSteer);

    const hold = (k: string, on: (v: boolean) => void) => {
      const el = this.root.querySelector(`[data-k="${k}"]`) as HTMLElement;
      const ids = new Set<number>();
      const sync = () => {
        el.classList.toggle('is-down', ids.size > 0);
        on(ids.size > 0);
      };
      el.addEventListener('pointerdown', (e) => {
        ids.add(e.pointerId);
        el.setPointerCapture(e.pointerId);
        sync();
        e.preventDefault();
      });
      const up = (e: PointerEvent) => {
        ids.delete(e.pointerId);
        sync();
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    const t = this.input.touch;
    hold('gas', (v) => (t.throttle = v ? 1 : 0));
    hold('brake', (v) => (t.brake = v ? 1 : 0));
    hold('nitro', (v) => (t.nitro = v));
    hold('drift', (v) => (t.handbrake = v ? 1 : 0));
    const tap = (k: string, fn: () => void) => {
      (this.root.querySelector(`[data-k="${k}"]`) as HTMLElement).addEventListener('pointerdown', (e) => {
        e.preventDefault();
        fn();
      });
    };
    tap('pause', () => this.onPause?.());
    tap('camera', () => this.onCamera?.());
    tap('reset', () => this.onReset?.());

    window.addEventListener('resize', () => this.updateRotate());
    this.show(false);
  }

  private setSteer(v: number) {
    // gentle curve so small thumb movements give fine control
    const s = Math.sign(v) * Math.pow(Math.abs(v), 1.25);
    this.input.touch.steer = s;
    this.knob.style.transform = `translateX(calc(-50% + ${v * 46}px))`;
  }

  private visible = false;

  show(on: boolean) {
    this.visible = on;
    this.root.style.display = on ? 'block' : 'none';
    const t = this.input.touch;
    t.active = on;
    if (!on) {
      t.steer = t.throttle = t.brake = t.handbrake = 0;
      t.nitro = false;
      this.steerId = -1;
      this.root.querySelectorAll('.is-down').forEach((el) => el.classList.remove('is-down'));
    }
    this.updateRotate();
  }

  private updateRotate() {
    this.rotate.style.display = this.visible && window.innerHeight > window.innerWidth * 1.05 ? 'flex' : 'none';
  }
}

const CSS = `
.tc{position:fixed;inset:0;z-index:40;pointer-events:none;user-select:none;-webkit-user-select:none;touch-action:none;font-family:"Barlow",sans-serif}
.tc *{touch-action:none}
.tc-steer{pointer-events:auto;position:absolute;left:0;bottom:0;width:44vw;height:62vh;display:flex;align-items:flex-end;justify-content:center;padding-bottom:max(18px,env(safe-area-inset-bottom))}
.tc-track{position:absolute;left:50%;bottom:max(46px,calc(env(safe-area-inset-bottom) + 30px));transform:translateX(-50%);width:150px;height:46px;border-radius:23px;
  background:rgba(14,15,17,.42);border:1px solid rgba(255,255,255,.22);display:flex;justify-content:space-between;align-items:center;padding:0 14px;color:rgba(244,242,238,.55);font-size:24px;box-sizing:border-box;
  backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}
.tc-knob{position:absolute;left:50%;bottom:max(42px,calc(env(safe-area-inset-bottom) + 26px));width:54px;height:54px;border-radius:50%;transform:translateX(-50%);
  background:rgba(244,242,238,.88);border:2px solid #fff;box-shadow:0 2px 10px rgba(0,0,0,.4)}
.tc-steer.is-active .tc-knob{background:#ffb400;border-color:#ffb400}
.tc-hint{position:absolute;bottom:max(104px,calc(env(safe-area-inset-bottom) + 88px));left:50%;transform:translateX(-50%);font-size:10px;font-weight:600;letter-spacing:.28em;color:rgba(244,242,238,.45);white-space:nowrap}
.tc-steer.is-active .tc-hint{opacity:0}
.tc-btn{pointer-events:auto;position:absolute;border:1px solid rgba(255,255,255,.24);color:#f4f2ee;font:600 13px "Barlow",sans-serif;letter-spacing:.2em;
  background:rgba(14,15,17,.46);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);border-radius:10px;padding:0;-webkit-tap-highlight-color:transparent;transition:background-color .08s,border-color .08s,color .08s}
.tc-btn.is-down{transform:scale(.95)}
.tc-gas{right:max(16px,env(safe-area-inset-right));bottom:max(18px,env(safe-area-inset-bottom));width:96px;height:132px;border-color:rgba(255,255,255,.4)}
.tc-gas.is-down{background:rgba(244,242,238,.9);color:#111;border-color:#fff}
.tc-brake{right:calc(max(16px,env(safe-area-inset-right)) + 108px);bottom:max(18px,env(safe-area-inset-bottom));width:84px;height:96px;border-color:rgba(239,68,68,.55)}
.tc-brake.is-down{background:rgba(239,68,68,.85);border-color:#ef4444}
.tc-round{border-radius:50%;width:68px;height:68px;font-size:11px;letter-spacing:.14em}
.tc-nitro{right:calc(max(16px,env(safe-area-inset-right)) + 14px);bottom:calc(max(18px,env(safe-area-inset-bottom)) + 146px);border-color:rgba(255,180,0,.65);color:#ffb400}
.tc-nitro.is-down{background:#ffb400;color:#1a1305;border-color:#ffb400}
.tc-drift{right:calc(max(16px,env(safe-area-inset-right)) + 116px);bottom:calc(max(18px,env(safe-area-inset-bottom)) + 108px)}
.tc-drift.is-down{background:rgba(244,242,238,.9);color:#111;border-color:#fff}
.tc-top{position:absolute;top:max(8px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);display:flex;gap:8px;pointer-events:auto;margin-top:34px}
.tc-mini{pointer-events:auto;font:600 10px "Barlow",sans-serif;letter-spacing:.2em;color:rgba(244,242,238,.85);background:rgba(14,15,17,.5);border:1px solid rgba(255,255,255,.2);border-radius:2px;padding:7px 10px 6px}
.tc-rotate{position:fixed;inset:0;z-index:80;display:none;flex-direction:column;align-items:center;justify-content:center;background:rgba(11,12,14,.94);color:#f4f2ee;font:500 15px "Barlow",sans-serif;letter-spacing:.06em;text-align:center}
.tc-rotate div{font-size:52px;color:#ffb400;animation:tcspin 2s ease-in-out infinite}
@keyframes tcspin{0%,20%{transform:rotate(0)}60%,100%{transform:rotate(90deg)}}
/* make room for thumbs: tach to the left middle, minimap up under the timer */
body.is-touch .hud-br{left:max(10px,env(safe-area-inset-left));right:auto;bottom:auto;top:38%;width:clamp(96px,22vmin,130px)}
body.is-touch .hud-gaps{display:none}
body.is-touch .hud-drift{top:calc(max(8px,env(safe-area-inset-top)) + 84px)}
body.is-touch .hud-bl{left:auto;bottom:auto;right:max(10px,env(safe-area-inset-right));top:calc(max(8px,env(safe-area-inset-top)) + 44px);width:clamp(64px,18vmin,92px)}
body.is-touch .hud-br,body.is-touch .hud-bl{pointer-events:none}
body.is-touch .hud-times{display:none}
body.is-touch .ywgi-credits-btn{bottom:auto;top:10px}
body.is-touch .hud-popups{right:auto;left:50%;transform:translateX(-50%);top:44%;align-items:center}
body.is-touch .hud-popup b,body.is-touch .hud-popup span{font-size:14px}
`;
