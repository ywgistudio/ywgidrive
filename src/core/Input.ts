/** Keyboard + gamepad input with analog smoothing for keys. */
export interface InputState {
  throttle: number;
  brake: number;
  steer: number; // -1 left .. +1 right
  handbrake: number;
  nitro: boolean;
  lookBack: boolean;
}

type Action =
  | 'throttle' | 'brake' | 'left' | 'right' | 'handbrake' | 'nitro'
  | 'camera' | 'reset' | 'shiftUp' | 'shiftDown' | 'lookBack' | 'pause' | 'mute';

const KEYMAP: Record<string, Action> = {
  KeyW: 'throttle', ArrowUp: 'throttle',
  KeyS: 'brake', ArrowDown: 'brake',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'handbrake',
  ShiftLeft: 'nitro', ShiftRight: 'nitro', KeyN: 'nitro',
  KeyC: 'camera',
  KeyR: 'reset',
  KeyE: 'shiftUp',
  KeyQ: 'shiftDown',
  KeyB: 'lookBack',
  Escape: 'pause', KeyP: 'pause',
  KeyM: 'mute',
};

export class Input {
  readonly state: InputState = { throttle: 0, brake: 0, steer: 0, handbrake: 0, nitro: false, lookBack: false };
  private held = new Set<Action>();
  private pressed = new Set<Action>();
  private keyThrottle = 0;
  private keyBrake = 0;
  usingGamepad = false;
  private prevButtons: boolean[] = [];
  /** Raw key listener for menus (gets every keydown). */
  onKey?: (code: string, e: KeyboardEvent) => void;
  /** Gamepad menu navigation events. */
  onPadNav?: (dir: 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back' | 'pause') => void;
  private padNavCooldown = 0;
  touch = { steer: 0, throttle: 0, brake: 0, handbrake: 0, nitro: false, active: false };

  constructor() {
    window.addEventListener('keydown', (e) => {
      const a = KEYMAP[e.code];
      if (a) {
        if (!this.held.has(a)) this.pressed.add(a);
        this.held.add(a);
        if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
      }
      this.usingGamepad = false;
      this.onKey?.(e.code, e);
    });
    window.addEventListener('keyup', (e) => {
      const a = KEYMAP[e.code];
      if (a) this.held.delete(a);
    });
    window.addEventListener('blur', () => this.held.clear());
  }

  /** True once per key press. */
  consume(a: Action): boolean {
    const p = this.pressed.has(a);
    this.pressed.delete(a);
    return p;
  }

  clearPressed() {
    this.pressed.clear();
  }

  update(dt: number) {
    const s = this.state;
    // keyboard: ramp throttle/brake so taps aren't binary
    const kt = this.held.has('throttle') ? 1 : 0;
    const kb = this.held.has('brake') ? 1 : 0;
    this.keyThrottle += (kt - this.keyThrottle) * Math.min(1, dt * (kt ? 9 : 14));
    this.keyBrake += (kb - this.keyBrake) * Math.min(1, dt * (kb ? 12 : 16));
    let steer = (this.held.has('right') ? 1 : 0) - (this.held.has('left') ? 1 : 0);
    let throttle = this.keyThrottle;
    let brake = this.keyBrake;
    let handbrake = this.held.has('handbrake') ? 1 : 0;
    let nitro = this.held.has('nitro');
    let lookBack = this.held.has('lookBack');

    // gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    this.padNavCooldown -= dt;
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const ax = p.axes[0] ?? 0;
      const dz = 0.12;
      const sx = Math.abs(ax) < dz ? 0 : (ax - Math.sign(ax) * dz) / (1 - dz);
      const rt = p.buttons[7]?.value ?? 0;
      const lt = p.buttons[6]?.value ?? 0;
      const anyPad = Math.abs(sx) > 0 || rt > 0.05 || lt > 0.05 || p.buttons.some((b) => b.pressed);
      if (anyPad) this.usingGamepad = true;
      if (this.usingGamepad) {
        // slight response curve for fine control at speed
        steer = Math.sign(sx) * Math.pow(Math.abs(sx), 1.4) || steer;
        throttle = Math.max(throttle, rt);
        brake = Math.max(brake, lt);
        if (p.buttons[0]?.pressed || p.buttons[5]?.pressed) handbrake = 1; // A / RB
        if (p.buttons[1]?.pressed || p.buttons[4]?.pressed) nitro = true; // B / LB
        if (p.buttons[10]?.pressed || p.buttons[2]?.pressed) lookBack = lookBack || !!p.buttons[10]?.pressed;
      }
      const edge = (i: number) => {
        const now = !!p.buttons[i]?.pressed;
        const was = this.prevButtons[i] ?? false;
        this.prevButtons[i] = now;
        return now && !was;
      };
      if (edge(3)) this.pressed.add('camera'); // Y
      if (edge(2)) this.pressed.add('reset'); // X
      if (edge(9)) this.pressed.add('pause'); // Start
      if (edge(13)) this.pressed.add('shiftDown');
      if (edge(12)) this.pressed.add('shiftUp');
      // menu nav
      if (this.onPadNav) {
        const ay = p.axes[1] ?? 0;
        if (this.padNavCooldown <= 0) {
          let dir: 'up' | 'down' | 'left' | 'right' | null = null;
          if (ay < -0.6 || p.buttons[12]?.pressed) dir = 'up';
          else if (ay > 0.6 || p.buttons[13]?.pressed) dir = 'down';
          else if (ax < -0.6 || p.buttons[14]?.pressed) dir = 'left';
          else if (ax > 0.6 || p.buttons[15]?.pressed) dir = 'right';
          if (dir) {
            this.onPadNav(dir);
            this.padNavCooldown = 0.2;
          }
        }
        if (p.buttons[0]?.pressed && !this.prevButtons[100]) this.onPadNav('confirm');
        if (p.buttons[1]?.pressed && !this.prevButtons[101]) this.onPadNav('back');
        this.prevButtons[100] = !!p.buttons[0]?.pressed;
        this.prevButtons[101] = !!p.buttons[1]?.pressed;
      }
      break;
    }

    if (this.touch.active) {
      steer = this.touch.steer || steer;
      throttle = Math.max(throttle, this.touch.throttle);
      brake = Math.max(brake, this.touch.brake);
      handbrake = Math.max(handbrake, this.touch.handbrake);
      nitro = nitro || this.touch.nitro;
    }

    s.steer = Math.max(-1, Math.min(1, steer));
    s.throttle = throttle;
    s.brake = brake;
    s.handbrake = handbrake;
    s.nitro = nitro;
    s.lookBack = lookBack;
  }
}
