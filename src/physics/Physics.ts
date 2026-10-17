import RAPIER from '@dimforge/rapier3d-compat';

export { RAPIER };

export const GROUP_STATIC = 0x0001;
export const GROUP_CAR = 0x0002;
export const GROUP_TRAFFIC = 0x0004;
export const GROUP_PROP = 0x0008;

export function groups(member: number, filter: number): number {
  return ((member & 0xffff) << 16) | (filter & 0xffff);
}

export const STATIC_GROUPS = groups(GROUP_STATIC, GROUP_CAR | GROUP_TRAFFIC | GROUP_PROP);
export const CAR_GROUPS = groups(GROUP_CAR, GROUP_STATIC | GROUP_CAR | GROUP_TRAFFIC | GROUP_PROP);
export const TRAFFIC_GROUPS = groups(GROUP_TRAFFIC, GROUP_STATIC | GROUP_CAR | GROUP_TRAFFIC | GROUP_PROP);
export const PROP_GROUPS = groups(GROUP_PROP, GROUP_STATIC | GROUP_CAR | GROUP_TRAFFIC | GROUP_PROP);
/** Wheel rays only see the static world (road, curbs, walls). */
export const WHEEL_RAY_GROUPS = groups(GROUP_CAR, GROUP_STATIC);

export const PHYSICS_HZ = 240;
export const PHYSICS_DT = 1 / PHYSICS_HZ;

export class Physics {
  world!: RAPIER.World;
  events!: RAPIER.EventQueue;

  async init() {
    await RAPIER.init();
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = PHYSICS_DT;
    this.events = new RAPIER.EventQueue(true);
  }

  step() {
    this.world.step(this.events);
  }
}
