import type { Vehicle } from '../vehicle/Vehicle';

export interface StyleEvent {
  title: string;
  sub: string;
  color: string;
  points: number;
  nitro: number;
}

/**
 * Street-racing style scoring for the player: drift combos, near misses, air, drafting.
 * Every event also refills nitro so playing stylishly is how you earn boost.
 */
export class Style {
  total = 0;
  driftPoints = 0;
  driftMult = 1;
  driftActive = false;
  private driftTime = 0;
  private calm = 0;
  private airStart = 0;
  private wasAir = false;
  bestDrift = 0;
  nearMisses = 0;
  topSpeed = 0;
  private draftTime = 0;
  events: StyleEvent[] = [];

  update(dt: number, v: Vehicle, crashed: boolean, drafting: boolean) {
    this.topSpeed = Math.max(this.topSpeed, v.speedKmh);
    const slip = Math.abs(v.bodySlip);
    const speed = Math.abs(v.speed);
    const grounded = v.groundedWheels >= 3;

    // ---- drift
    if (grounded && speed > 12 && slip > 0.22) {
      this.driftActive = true;
      this.calm = 0;
      this.driftTime += dt;
      this.driftMult = Math.min(5, 1 + Math.floor(this.driftTime / 1.5));
      this.driftPoints += dt * speed * (slip * 6) * this.driftMult;
    } else if (this.driftActive) {
      this.calm += dt;
      if (this.calm > 0.7 || speed < 6) this.bankDrift();
    }
    if (crashed && this.driftActive) {
      this.events.push({ title: 'DRIFT LOST', sub: '', color: '#ff3355', points: 0, nitro: 0 });
      this.driftActive = false;
      this.driftPoints = 0;
      this.driftTime = 0;
      this.driftMult = 1;
    }

    // ---- air
    const air = v.groundedWheels === 0;
    if (air && !this.wasAir) this.airStart = v.airTime;
    if (!air && this.wasAir) {
      const t = this._lastAir;
      if (t > 0.45) {
        const pts = Math.round(t * 600);
        this.add(t > 1.0 ? 'BIG AIR' : 'AIR', `+${pts}`, '#7cf8ff', pts, Math.min(0.2, t * 0.12));
      }
    }
    if (air) this._lastAir = v.airTime;
    this.wasAir = air;

    // ---- drafting
    if (drafting && speed > 30) {
      this.draftTime += dt;
      if (this.draftTime > 1.2) {
        this.add('SLIPSTREAM', '+150', '#9dff6a', 150, 0.06);
        this.draftTime = -1.5;
      }
    } else this.draftTime = Math.min(this.draftTime, 0) + dt * 0;
  }

  private _lastAir = 0;

  private bankDrift() {
    const pts = Math.round(this.driftPoints);
    if (pts > 120) {
      const title = pts > 6000 ? 'INSANE DRIFT' : pts > 2500 ? 'MEGA DRIFT' : pts > 1000 ? 'GREAT DRIFT' : 'DRIFT';
      this.add(title, `+${pts}  x${this.driftMult}`, '#ff3df2', pts, Math.min(0.35, pts / 9000));
      this.bestDrift = Math.max(this.bestDrift, pts);
    }
    this.driftActive = false;
    this.driftPoints = 0;
    this.driftTime = 0;
    this.driftMult = 1;
    this.calm = 0;
  }

  nearMiss(oncoming: boolean, speedKmh: number) {
    this.nearMisses++;
    const pts = Math.round((oncoming ? 400 : 250) * (1 + Math.max(0, speedKmh - 120) / 150));
    this.add(oncoming ? 'ONCOMING NEAR MISS' : 'NEAR MISS', `+${pts}`, oncoming ? '#ffb000' : '#ffe14d', pts, oncoming ? 0.12 : 0.08);
  }

  add(title: string, sub: string, color: string, points: number, nitro: number) {
    this.total += points;
    this.events.push({ title, sub, color, points, nitro });
  }

  drain(): StyleEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  reset() {
    this.total = 0;
    this.driftPoints = 0;
    this.driftMult = 1;
    this.driftActive = false;
    this.driftTime = 0;
    this.bestDrift = 0;
    this.nearMisses = 0;
    this.topSpeed = 0;
    this.events = [];
  }
}
