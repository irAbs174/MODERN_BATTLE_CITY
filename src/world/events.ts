import type { PowerUpId } from '../data/powerups';
import type { EnemyId } from '../data/enemies';
import type { WeaponId } from '../data/weapons';

/** Everything the simulation broadcasts to audio / UI / render layers. */
export interface GameEvents {
  shot: {
    x: number;
    y: number;
    angle: number;
    weapon: WeaponId;
    team: 'player' | 'enemy';
    power: number;
  };
  impact: {
    x: number;
    y: number;
    nx: number;
    ny: number;
    kind: 'tank' | 'terrain' | 'steel' | 'shield' | 'bullet';
    damage: number;
    crit: boolean;
    color: string;
    power: number;
  };
  explosion: {
    x: number;
    y: number;
    radius: number;
    power: number;
    color: string;
    big: boolean;
  };
  terrainDestroyed: { cx: number; cy: number; x: number; y: number; terrain: number; power: number };
  tankDestroyed: {
    x: number;
    y: number;
    enemy: EnemyId;
    boss: boolean;
    color: string;
    size: number;
    byPlayer: boolean;
  };
  playerDamaged: { hp: number; maxHp: number; amount: number };
  playerDied: { x: number; y: number };
  baseDamaged: { hp: number; maxHp: number; amount: number };
  baseDestroyed: { x: number; y: number };
  powerupSpawned: { x: number; y: number; id: PowerUpId };
  powerupCollected: { x: number; y: number; id: PowerUpId; text: string };
  combo: { count: number; x: number; y: number };
  waveStart: { wave: number; announce: string; boss: boolean };
  waveCleared: { wave: number };
  levelComplete: { score: number; time: number };
  levelFailed: { reason: 'base' | 'lives' };
  shake: { amount: number; freq?: number };
  flash: { alpha: number; color: string; duration: number };
  slowmo: { scale: number; duration: number };
  sfx: { name: SfxName; x?: number; y?: number; volume?: number; pitch?: number };
  abilityUsed: { id: string; x: number; y: number };
  enemySpawn: { x: number; y: number; enemy: EnemyId; elite: boolean };
  bossPhase: { phase: number; name: string };
  turretPlaced: { x: number; y: number };
  hitmarker: { x: number; y: number; damage: number; crit: boolean; kill: boolean };
}

export type SfxName =
  | 'shot_cannon'
  | 'shot_rapid'
  | 'shot_heavy'
  | 'shot_plasma'
  | 'shot_rocket'
  | 'shot_rail'
  | 'shot_flame'
  | 'shot_mortar'
  | 'enemy_shot'
  | 'hit_metal'
  | 'hit_flesh'
  | 'brick'
  | 'steel'
  | 'explosion_small'
  | 'explosion_big'
  | 'explosion_huge'
  | 'pickup'
  | 'power'
  | 'life'
  | 'ui_move'
  | 'ui_select'
  | 'ui_back'
  | 'ui_error'
  | 'ui_purchase'
  | 'level_start'
  | 'level_complete'
  | 'level_failed'
  | 'boss_warn'
  | 'boss_die'
  | 'shield_up'
  | 'shield_break'
  | 'emp'
  | 'dash'
  | 'teleport'
  | 'airstrike'
  | 'drone'
  | 'repair'
  | 'engine'
  | 'tread'
  | 'combo'
  | 'wave'
  | 'alarm'
  | 'freeze'
  | 'nuke'
  | 'crit'
  | 'reload';

export const SFX_WEAPON_MAP: Record<string, SfxName> = {
  cannon: 'shot_cannon',
  rapid: 'shot_rapid',
  heavy: 'shot_heavy',
  plasma: 'shot_plasma',
  rocket: 'shot_rocket',
  railgun: 'shot_rail',
  flame: 'shot_flame',
  mortar: 'shot_mortar',
};
