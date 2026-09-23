import { CFG } from '../core/config';
import { angleDiff, clamp } from '../core/math';
import type { EnemyTank } from '../entities/EnemyTank';
import type { World } from '../world/World';
import type { AiArchetype } from '../data/enemies';

export type AiState =
  | 'advance'
  | 'engage'
  | 'flank'
  | 'cover'
  | 'retreat'
  | 'reposition'
  | 'hold'
  | 'stun'
  | 'charge';

export interface MoveCommand {
  dirX: number;
  dirY: number;
  throttle: number;
  aim: number;
  fire: boolean;
  /** Fire immediately even if aim is imperfect (boss patterns). */
  forceFire: boolean;
}

const EMPTY_CMD: MoveCommand = { dirX: 0, dirY: 0, throttle: 0, aim: 0, fire: false, forceFire: false };

/**
 * Tactical decision layer. Enemies pick targets, use the shared flow fields,
 * hold their preferred engagement range, break line of sight when hurt and
 * flank instead of beelining — per archetype.
 */
export class EnemyBrain {
  state: AiState = 'advance';
  stateTime = 0;
  decisionTimer = 0;
  strafeDir = Math.random() < 0.5 ? -1 : 1;
  strafeTimer = 0;
  targetX = 0;
  targetY = 0;
  hasTarget = false;
  aimAngle = -Math.PI / 2;
  lastSeenX = 0;
  lastSeenY = 0;
  seenRecently = false;
  stuckTimer = 0;
  lastX = 0;
  lastY = 0;
  flowFallback = 0;
  reaction = 0.3;
  reactionTimer = 0;
  aimError = 0;
  aimErrorTimer = 0;
  burstLeft = 0;
  burstTimer = 0;
  chargeTime = 0;
  charging = false;
  repositionTarget: { x: number; y: number } | null = null;
  flankSide = 1;
  flankTimer = 0;
  mineTimer = 4;
  teleportTimer = 6;
  aggression = 1;
  /** Set by the boss controller to override normal thinking. */
  override: ((tank: EnemyTank, world: World, dt: number, cmd: MoveCommand) => void) | null = null;
  private cmd: MoveCommand = { ...EMPTY_CMD };

  constructor(archetype: AiArchetype, reaction: number, accuracy: number) {
    this.reaction = reaction * (0.8 + Math.random() * 0.4);
    this.aggression = archetype === 'aggressive' || archetype === 'flanker' ? 1.25 : 1;
    this.aimError = (1 - accuracy) * 0.5;
  }

  reset(): void {
    this.state = 'advance';
    this.stateTime = 0;
    this.decisionTimer = 0;
    this.charging = false;
    this.burstLeft = 0;
    this.stuckTimer = 0;
    this.flowFallback = 0;
  }

  think(tank: EnemyTank, world: World, dt: number): MoveCommand {
    const cmd = this.cmd;
    cmd.dirX = 0;
    cmd.dirY = 0;
    cmd.throttle = 1;
    cmd.fire = false;
    cmd.forceFire = false;

    if (tank.stun > 0 || tank.freeze > 0 || tank.empTimer > 0) {
      this.state = 'stun';
      cmd.aim = tank.turret;
      return cmd;
    }

    this.stateTime += dt;
    this.decisionTimer -= dt;
    this.strafeTimer -= dt;
    this.flowFallback = Math.max(0, this.flowFallback - dt);
    this.reactionTimer -= dt;
    this.aimErrorTimer -= dt;

    if (this.aimErrorTimer <= 0) {
      this.aimErrorTimer = 0.45 + Math.random() * 0.5;
      // jitter aim; elites and higher difficulty tighten the cone
      const skill = clamp(0.35 + world.difficultyAcc * 0.5 + (tank.elite ? 0.2 : 0), 0, 1);
      this.aimError = (1 - tank.def.accuracy * skill) * 0.42 * (Math.random() * 2 - 1);
    }

    // --- pick a target -------------------------------------------------
    const player = world.player;
    const base = world.base;
    const playerAlive = !!player && player.alive;
    let tx = this.lastSeenX;
    let ty = this.lastSeenY;
    let targetIsBase = false;

    const distToPlayer = playerAlive ? Math.hypot(player!.x - tank.x, player!.y - tank.y) : Infinity;
    const distToBase = base && base.alive ? Math.hypot(base.x - tank.x, base.y - tank.y) : Infinity;

    const archetype = tank.def.archetype;
    const losToPlayer =
      playerAlive &&
      distToPlayer < tank.def.sightRange &&
      world.grid.hasLineOfSight(tank.x, tank.y, player!.x, player!.y);

    if (losToPlayer) {
      this.lastSeenX = player!.x;
      this.lastSeenY = player!.y;
      this.seenRecently = true;
      this.hasTarget = true;
    } else if (this.seenRecently && this.stateTime > 4) {
      this.seenRecently = false;
    }

    if (archetype === 'raider' && base && base.alive && (distToBase > 70 || !losToPlayer)) {
      targetIsBase = true;
    } else if (!playerAlive) {
      targetIsBase = true;
    } else if (archetype === 'guardian' && distToPlayer > tank.def.idealRange * 2.2) {
      targetIsBase = true;
    } else if (this.stateTime > 9 && !losToPlayer && world.rng.chance(dt * 0.6)) {
      // occasional opportunistic base pressure so players can never turtle
      targetIsBase = world.rng.chance(0.35);
    }

    if (targetIsBase && base && base.alive) {
      tx = base.x;
      ty = base.y;
    } else if (playerAlive) {
      tx = losToPlayer ? player!.x : this.lastSeenX;
      ty = losToPlayer ? player!.y : this.lastSeenY;
    }
    this.targetX = tx;
    this.targetY = ty;
    const distToTarget = Math.hypot(tx - tank.x, ty - tank.y);

    // --- state machine --------------------------------------------------
    if (this.decisionTimer <= 0) {
      this.decisionTimer = 0.18 + Math.random() * 0.22;
      this.transition(tank, world, losToPlayer, distToTarget, distToPlayer, targetIsBase);
    }

    if (this.strafeTimer <= 0) {
      this.strafeTimer = 0.7 + Math.random() * 1.5;
      if (Math.random() < 0.6) this.strafeDir *= -1;
    }

    // --- movement -------------------------------------------------------
    const flow = targetIsBase ? world.flowToBase : world.flowToPlayer;
    let dirX = 0;
    let dirY = 0;

    // stuck detection -> lean on the flow field
    const moved = Math.hypot(tank.x - this.lastX, tank.y - this.lastY);
    this.lastX = tank.x;
    this.lastY = tank.y;
    if (moved < 12 * dt && (this.state === 'advance' || this.state === 'flank' || this.state === 'reposition')) {
      this.stuckTimer += dt;
    } else {
      this.stuckTimer = Math.max(0, this.stuckTimer - dt * 2);
    }
    if (this.stuckTimer > 0.35) this.flowFallback = 1.1;

    switch (this.state) {
      case 'advance': {
        const s = flow.sample(tank.x, tank.y);
        // weave slightly so packs don't stack into a single file
        const perp = this.strafeDir * 0.22;
        dirX = s.dx + -s.dy * perp;
        dirY = s.dy + s.dx * perp;
        break;
      }
      case 'engage': {
        const toT = Math.atan2(ty - tank.y, tx - tank.x);
        const ideal = tank.def.idealRange;
        let radial = 0;
        if (distToTarget > ideal * 1.18) radial = 1;
        else if (distToTarget < ideal * 0.72) radial = -1;
        const strafe = distToTarget < ideal * 1.6 ? this.strafeDir * 0.85 : this.strafeDir * 0.3;
        dirX = Math.cos(toT) * radial + Math.cos(toT + Math.PI / 2) * strafe;
        dirY = Math.sin(toT) * radial + Math.sin(toT + Math.PI / 2) * strafe;
        if (this.flowFallback > 0) {
          const s = flow.sample(tank.x, tank.y);
          dirX = dirX * 0.45 + s.dx * 0.55;
          dirY = dirY * 0.45 + s.dy * 0.55;
        }
        break;
      }
      case 'flank': {
        const toP = Math.atan2(ty - tank.y, tx - tank.x);
        const side = toP + (Math.PI / 2) * this.flankSide;
        const flankX = tx + Math.cos(side) * 130;
        const flankY = ty + Math.sin(side) * 130;
        let dx = flankX - tank.x;
        let dy = flankY - tank.y;
        const l = Math.hypot(dx, dy) || 1;
        dirX = dx / l;
        dirY = dy / l;
        if (this.flowFallback > 0 || l < 60) {
          const s = flow.sample(tank.x, tank.y);
          dirX = s.dx;
          dirY = s.dy;
        }
        this.flankTimer -= dt;
        if (this.flankTimer <= 0) {
          this.flankSide *= -1;
          this.flankTimer = 2.4 + Math.random() * 2;
        }
        break;
      }
      case 'cover':
      case 'retreat': {
        const s = flow.sample(tank.x, tank.y);
        // back away while sliding sideways so we don't reverse into a wall
        const bx = -s.dx;
        const by = -s.dy;
        dirX = bx + -by * this.strafeDir * 0.75;
        dirY = by + bx * this.strafeDir * 0.75;
        const l = Math.hypot(dirX, dirY) || 1;
        dirX /= l;
        dirY /= l;
        if (losToPlayer && distToPlayer < 90) {
          // too close to disengage: fight back while backing off
          cmd.fire = true;
        }
        break;
      }
      case 'reposition': {
        const rp = this.repositionTarget;
        if (!rp) {
          this.state = 'advance';
          break;
        }
        let dx = rp.x - tank.x;
        let dy = rp.y - tank.y;
        const l = Math.hypot(dx, dy);
        if (l < 26) {
          this.state = 'engage';
          this.stateTime = 0;
          break;
        }
        dirX = dx / l;
        dirY = dy / l;
        if (this.flowFallback > 0) {
          const s = flow.sample(tank.x, tank.y);
          dirX = s.dx;
          dirY = s.dy;
        }
        break;
      }
      case 'hold': {
        dirX = 0;
        dirY = 0;
        break;
      }
      default:
        break;
    }

    cmd.dirX = clamp(dirX, -1, 1);
    cmd.dirY = clamp(dirY, -1, 1);
    cmd.throttle = this.state === 'retreat' || this.state === 'cover' ? 1.05 : 1;

    // --- aiming ---------------------------------------------------------
    let aimTargetX = tx;
    let aimTargetY = ty;
    if (playerAlive && !targetIsBase && losToPlayer) {
      const ps = tank.def.projSpeed;
      const d = distToPlayer;
      const t = d / Math.max(60, ps);
      aimTargetX = player!.x + player!.vx * t * clamp(tank.def.accuracy, 0.2, 1);
      aimTargetY = player!.y + player!.vy * t * clamp(tank.def.accuracy, 0.2, 1);
    }
    const desiredAim = Math.atan2(aimTargetY - tank.y, aimTargetX - tank.x) + this.aimError;
    cmd.aim = desiredAim;
    this.aimAngle = desiredAim;

    // --- firing ---------------------------------------------------------
    const aligned = Math.abs(angleDiff(tank.turret, desiredAim)) < (archetype === 'sniper' ? 0.07 : 0.2);
    const canSee = targetIsBase
      ? base && base.alive && world.grid.hasLineOfSight(tank.x, tank.y, base.x, base.y)
      : losToPlayer;
    const inRange = distToTarget < tank.def.sightRange * 1.05;

    if (this.burstLeft > 0) {
      this.burstTimer -= dt;
      if (this.burstTimer <= 0 && canSee && aligned) {
        cmd.fire = true;
        cmd.forceFire = true;
        this.burstLeft--;
        this.burstTimer = 0.16;
      }
    } else if (this.charging) {
      this.chargeTime -= dt;
      cmd.fire = false;
      if (this.chargeTime <= 0) {
        this.charging = false;
        cmd.fire = true;
        cmd.forceFire = true;
        tank.chargeTelegraph = 0;
      }
    } else if (canSee && aligned && inRange && this.reactionTimer <= 0 && tank.fireCooldown <= 0) {
      if (archetype === 'sniper' && tank.def.abilities?.includes('charge')) {
        this.charging = true;
        this.chargeTime = 0.62;
        tank.chargeTelegraph = 1;
      } else {
        cmd.fire = true;
        this.reactionTimer = this.reaction;
        if (tank.def.abilities?.includes('burst') && Math.random() < 0.45) {
          this.burstLeft = 2;
          this.burstTimer = 0.16;
        }
      }
    }

    if (this.override) this.override(tank, world, dt, cmd);
    return cmd;
  }

  private transition(
    tank: EnemyTank,
    world: World,
    losToPlayer: boolean,
    distToTarget: number,
    distToPlayer: number,
    targetIsBase: boolean,
  ): void {
    const arch = tank.def.archetype;
    const hurt = tank.hpFrac < (tank.elite ? 0.28 : 0.38);
    const canHeal = tank.shieldMax > 0 && tank.shield > tank.shieldMax * 0.3;

    // Bosses are driven by their own controller
    if (arch === 'boss') return;

    if (hurt && !canHeal && arch !== 'brawler' && arch !== 'raider' && !targetIsBase) {
      this.setState(Math.random() < 0.5 ? 'retreat' : 'cover');
      return;
    }

    switch (arch) {
      case 'aggressive':
        this.setState(losToPlayer && distToTarget < 220 ? 'engage' : 'advance');
        break;
      case 'balanced':
        this.setState(losToPlayer ? 'engage' : 'advance');
        break;
      case 'brawler':
        this.setState(losToPlayer && distToTarget < tank.def.idealRange * 1.3 ? 'engage' : 'advance');
        break;
      case 'sniper':
        if (losToPlayer && distToPlayer > tank.def.idealRange * 0.7) this.setState('engage');
        else if (losToPlayer && distToPlayer <= tank.def.idealRange * 0.7) this.setState('reposition');
        else if (this.state !== 'reposition') this.setState('advance');
        if (this.state === 'reposition' && !this.repositionTarget) {
          this.repositionTarget = this.findSniperSpot(tank, world);
        }
        break;
      case 'artillery':
        if (distToTarget < tank.def.idealRange * 0.75) this.setState('reposition');
        else this.setState(losToPlayer ? 'engage' : 'advance');
        if (this.state === 'reposition' && !this.repositionTarget) {
          this.repositionTarget = this.findSniperSpot(tank, world, true);
        }
        break;
      case 'guardian':
        this.setState(losToPlayer && distToPlayer < 300 ? 'engage' : 'advance');
        break;
      case 'flanker':
        if (losToPlayer && distToPlayer < 110) this.setState('engage');
        else this.setState('flank');
        break;
      case 'raider':
        this.setState(targetIsBase ? 'advance' : losToPlayer && distToPlayer < 130 ? 'engage' : 'advance');
        break;
      default:
        this.setState('advance');
    }
  }

  private setState(s: AiState): void {
    if (this.state !== s) {
      this.state = s;
      this.stateTime = 0;
      if (s === 'flank') this.flankTimer = 2 + Math.random() * 2;
      if (s !== 'reposition') this.repositionTarget = null;
    }
  }

  private findSniperSpot(tank: EnemyTank, world: World, keepAway = false): { x: number; y: number } | null {
    const player = world.player;
    if (!player || !player.alive) return null;
    let best: { x: number; y: number; score: number } | null = null;
    const ideal = keepAway ? tank.def.idealRange : tank.def.idealRange * 0.9;
    for (let i = 0; i < 14; i++) {
      const a = world.rng.range(0, Math.PI * 2);
      const r = ideal * world.rng.range(0.7, 1.25);
      const x = clamp(player.x + Math.cos(a) * r, 30, world.grid.width - 30);
      const y = clamp(player.y + Math.sin(a) * r, 30, world.grid.height - 30);
      if (world.grid.rectHitsSolid({ x: x - tank.size / 2, y: y - tank.size / 2, w: tank.size, h: tank.size }, { hover: tank.hover, offroad: false }))
        continue;
      if (!world.grid.hasLineOfSight(x, y, player.x, player.y)) continue;
      const d = Math.hypot(x - tank.x, y - tank.y);
      const score = -d * 0.4 + (world.grid.hasLineOfSight(x, y, player.x, player.y) ? 100 : 0);
      if (!best || score > best.score) best = { x, y, score };
    }
    if (!best) {
      const a = world.rng.range(0, Math.PI * 2);
      return {
        x: clamp(tank.x + Math.cos(a) * 120, 30, world.grid.width - 30),
        y: clamp(tank.y + Math.sin(a) * 120, 30, world.grid.height - 30),
      };
    }
    return { x: best.x, y: best.y };
  }
}

export const AI_THINK_INTERVAL = CFG.ai.flowFieldInterval;
