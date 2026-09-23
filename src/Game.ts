import type { World } from './world/World';
import { buildLevel, buildFromGen, type BuiltLevel } from './world/LevelBuilder';
import { generateArena } from './world/LevelGen';
import { getLevel, CAMPAIGN_STAGE_COUNT } from './world/levels';
import {
  CampaignMode,
  EndlessMode,
  SurvivalMode,
  BossRushMode,
  ChallengeMode,
  randomSeed,
} from './modes';
import type { GameMode } from './modes/GameMode';
import { PlayerTank, type PlayerInput } from './entities/PlayerTank';
import { Camera } from './render/Camera';
import { Renderer, type RenderOpts } from './render/Renderer';
import type { TankColors } from './render/sprites';
import { audioInstance as audio } from './audio/AudioManager';
import { InputManager, type Action } from './input/InputManager';
import { SaveSystem, type ScoreEntry, type Settings } from './meta/SaveSystem';
import {
  COSMETICS,
  computeRewards,
  recordScore,
  type RewardBreakdown,
  type RunResult,
} from './meta/Progression';
import { CHASSIS } from './data/progression';
import type { WeaponId } from './data/weapons';
import { getDifficulty, combatFromDifficulty } from './core/config';
import { clamp, formatNumber, formatTime } from './core/math';
import { UIManager } from './ui/UIManager';
import type { HudState } from './ui/Hud';
import type { UiHost } from './ui/Screens';
import type { SfxName } from './world/events';
import type { ThemeId } from './world/terrain';

type Phase = 'boot' | 'menu' | 'playing' | 'paused' | 'results';
type RunKind = { type: 'campaign'; stageId: number } | { type: ArcadeMode; seed: number };
type ArcadeMode = 'endless' | 'survival' | 'challenge' | 'bossrush';

const FIXED = 1 / 60;
const MAX_STEPS = 5;
const MUSIC_BY_THEME: Record<ThemeId, string> = {
  arid: 'desert',
  tundra: 'frost',
  jungle: 'jungle',
  industrial: 'steel',
  night: 'night',
  volcanic: 'inferno',
  void: 'steel',
};
const DARKNESS_BY_THEME: Partial<Record<ThemeId, number>> = { night: 0.3, void: 0.22 };
const MODE_LABEL: Record<string, string> = {
  endless: 'ENDLESS',
  survival: 'SURVIVAL',
  challenge: 'CHALLENGE',
  bossrush: 'BOSS RUSH',
};

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function prettyKey(code?: string): string {
  if (!code) return 'E';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return code.slice(5).toUpperCase();
  if (code.startsWith('Mouse')) return ['LMB', 'MMB', 'RMB'][Number(code.slice(5))] ?? code;
  if (code === 'Space') return 'SPACE';
  if (code === 'Escape') return 'ESC';
  if (code === 'ShiftLeft') return 'SHIFT';
  return code.toUpperCase();
}

/**
 * Top-level orchestrator. Owns the run lifecycle, the fixed-step simulation
 * loop, rendering, audio routing and the bridge between the DOM UI and the
 * DOM-free World simulation.
 */
export class Game implements UiHost {
  readonly canvas: HTMLCanvasElement;
  readonly save = new SaveSystem();
  readonly input = new InputManager();
  readonly camera = new Camera();
  readonly renderer: Renderer;
  readonly ui: UIManager;

  world: World | null = null;
  private mode: GameMode | null = null;
  private built: BuiltLevel | null = null;
  private player: PlayerTank | null = null;

  private phase: Phase = 'boot';
  private runKind: RunKind | null = null;
  private pendingNextStage: number | null = null;
  private unsubscribes: (() => void)[] = [];

  private rafId = 0;
  private lastTime = 0;
  private acc = 0;
  private aimPoint: { x: number; y: number } | null = null;
  private inputLockUntil = 0;
  private lastQuality = '';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new Renderer(canvas, this.camera);
    this.ui = new UIManager(this, this.input);
  }

  /* ------------------------------------------------------------------ */
  /* bootstrap                                                           */
  /* ------------------------------------------------------------------ */

  async boot(): Promise<void> {
    this.input.attach(this.canvas);
    this.ui.init({
      pause: () => this.togglePause(),
      resume: () => this.resume(),
      restart: () => this.restart(),
      weaponSwap: () => this.player?.cycleWeapon(1),
      ability: () => this.triggerAbility(),
      primaryAction: () => this.primaryAction(),
    });
    this.bindWindow();
    this.save.load();
    this.applyAllSettings();
    this.resize();

    this.ui.screens.setBootProgress(0.15, 'Loading commander profile…');
    await delay(130);
    this.ui.screens.setBootProgress(0.45, 'Calibrating forge systems…');
    await delay(130);
    this.ui.screens.setBootProgress(0.75, 'Warming up the reactor…');
    await delay(130);
    this.ui.screens.refreshMenu();
    this.ui.screens.setBootProgress(1, 'Ready');
    await delay(200);

    this.phase = 'menu';
    this.ui.show('menu');
    this.startLoop();
  }

  private bindWindow(): void {
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 150));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.phase === 'playing') this.pause();
    });
    window.addEventListener('beforeunload', () => this.save.flush());
    // Unlock Web Audio on the first gesture (browser autoplay policy).
    const unlock = () => {
      audio.init();
      void audio.resume();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  private resize(): void {
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    const q = this.save.save.settings.quality;
    const dpr = Math.min(window.devicePixelRatio || 1, q === 'low' ? 1 : 2);
    this.renderer.resize(cssW, cssH, dpr);
    this.camera.setViewport(cssW, cssH, dpr);
    // Refit the arena to the new viewport (camera is a fixed single-screen fit).
    if (this.built) this.camera.setWorld(this.built.grid.width, this.built.grid.height);
  }

  /* ------------------------------------------------------------------ */
  /* settings                                                            */
  /* ------------------------------------------------------------------ */

  private applyAllSettings(): void {
    const s = this.save.save.settings;
    audio.setVolumes(s.masterVolume, s.sfxVolume, s.musicVolume);
    this.renderer.quality = s.quality === 'low' ? 0.4 : s.quality === 'medium' ? 0.7 : 1;
    if (this.world && s.quality !== this.lastQuality) this.renderer.buildTerrain(this.world);
    this.lastQuality = s.quality;
    this.camera.shakeEnabled = s.screenShake;
    this.camera.shakeIntensity = s.shakeIntensity;
    this.camera.reducedMotion = s.reducedMotion;
    this.input.resetBinds();
    this.input.applyBinds(s.keybinds as Partial<Record<Action, string>>);
    this.ui.applySettings(s);
  }

  onSettingChanged(_key: keyof Settings, _value: Settings[keyof Settings]): void {
    this.applyAllSettings();
    this.resize();
  }

  onGarageChanged(): void {
    this.ui.screens.refreshMenu();
  }

  /* ------------------------------------------------------------------ */
  /* run construction                                                    */
  /* ------------------------------------------------------------------ */

  startCampaign(stageId: number): void {
    this.runKind = { type: 'campaign', stageId };
    this.launchRun();
  }

  startMode(mode: ArcadeMode): void {
    this.runKind = { type: mode, seed: randomSeed() };
    this.launchRun();
  }

  private launchRun(): void {
    if (!this.runKind) return;
    const save = this.save.save;
    const diff = getDifficulty(save.settings.difficulty);
    const rk = this.runKind;
    const difficulty = combatFromDifficulty(diff);

    let built: BuiltLevel;
    let mode: GameMode;
    if (rk.type === 'campaign') {
      const level = getLevel(rk.stageId);
      built = buildLevel(level, { save, seed: rk.stageId * 7919 + 13, stageId: rk.stageId, difficulty });
      mode = new CampaignMode(rk.stageId);
    } else {
      const seed = rk.seed;
      const boss = rk.type === 'bossrush';
      const gen = generateArena({
        seed,
        blocksX: boss ? 26 : 24,
        blocksY: boss ? 26 : 24,
        density: rk.type === 'survival' ? 0.34 : boss ? 0.3 : 0.5,
        openness: rk.type === 'survival' ? 0.66 : 0.5,
        symmetric: true,
        id: seed % 1000,
        name: rk.type.toUpperCase(),
      });
      built = buildFromGen(gen, { save, seed, skipBase: rk.type === 'survival', difficulty });
      mode =
        rk.type === 'endless'
          ? new EndlessMode(seed)
          : rk.type === 'survival'
            ? new SurvivalMode(seed)
            : rk.type === 'challenge'
              ? new ChallengeMode(seed)
              : new BossRushMode();
    }

    // ---- player ----
    const chassis = CHASSIS[save.meta.chassis] ?? CHASSIS.ranger;
    const weapons: WeaponId[] = save.meta.loadout.length ? [...save.meta.loadout] : ['cannon'];
    const player = new PlayerTank(chassis, save.meta.upgrades, weapons, save.meta.equippedAbility);
    player.maxHp = Math.max(1, Math.round(player.maxHp * diff.playerHp));
    player.hp = player.maxHp;
    player.lives = diff.lives;
    player.x = built.playerSpawn.x;
    player.y = built.playerSpawn.y;
    player.angle = -Math.PI / 2;
    player.alive = true;
    player.invuln = 2.6;
    player.invulnOnSpawn = 2.6;
    built.world.setPlayer(player);

    // mount HQ defense turrets from the meta loadout
    const corners: [number, number][] = [
      [-built.base.size * 0.62, -built.base.size * 0.62],
      [built.base.size * 0.62, -built.base.size * 0.62],
      [-built.base.size * 0.62, built.base.size * 0.62],
      [built.base.size * 0.62, built.base.size * 0.62],
    ];
    for (let i = 0; i < clamp(save.base.turrets, 0, 4); i++) {
      const c = corners[i];
      const spot = built.world.findOpenSpot(built.base.x + c[0], built.base.y + c[1], 40);
      built.base.addTurret(built.world, spot.x - built.base.x, spot.y - built.base.y);
    }

    mode.attach(built);

    this.built = built;
    this.world = built.world;
    this.mode = mode;
    this.player = player;

    this.camera.setWorld(built.grid.width, built.grid.height);
    this.renderer.buildTerrain(built.world);
    this.subscribeWorld(built.world);
    this.ui.reset();
    this.ui.showGameUi();
    this.ui.setRunActive(true);
    this.resize();

    this.phase = 'playing';
    this.acc = 0;
    this.inputLockUntil = performance.now() + 350;
    audio.stopMusic();
    audio.startMusic(MUSIC_BY_THEME[built.theme] ?? 'desert', 0.32);
    audio.play('level_start', { volume: 0.9 });
    const label = rk.type === 'campaign' ? `STAGE ${rk.stageId} · ${getLevel(rk.stageId).name}` : mode.displayName;
    this.ui.banner(label, false);
  }

  private subscribeWorld(world: World): void {
    this.clearSubs();
    const settings = () => this.save.save.settings;
    this.unsubscribes.push(
      world.events.on('sfx', (e) => {
        let pan = 0;
        if (e.x !== undefined) {
          const halfW = this.camera.viewW / Math.max(0.0001, this.camera.zoom) / 2;
          pan = clamp((e.x - this.camera.x) / Math.max(1, halfW), -1, 1);
        }
        audio.play(e.name, { volume: e.volume ?? 1, pitch: e.pitch ?? 1, pan });
      }),
      world.events.on('hitmarker', (e) => {
        if (settings().hitmarkers) this.ui.hitmarker(e.kill ? 'kill' : e.crit ? 'crit' : 'normal');
      }),
      world.events.on('waveStart', (e) => this.ui.banner(e.announce, e.boss)),
      world.events.on('bossPhase', (e) => {
        this.ui.banner(`PHASE ${e.phase} — ${e.name}`, true);
        audio.startMusic(MUSIC_BY_THEME[this.built?.theme ?? 'arid'] ?? 'desert', 0.62);
      }),
      world.events.on('slowmo', (e) => {
        world.timeScale = Math.min(world.timeScale, e.scale);
      }),
      world.events.on('shake', (e) => this.camera.addPunch(e.amount * 0.006)),
    );
  }

  private clearSubs(): void {
    for (const u of this.unsubscribes) u();
    this.unsubscribes = [];
  }

  /* ------------------------------------------------------------------ */
  /* main loop                                                           */
  /* ------------------------------------------------------------------ */

  private startLoop(): void {
    this.lastTime = performance.now();
    const frame = (now: number) => {
      this.rafId = requestAnimationFrame(frame);
      const realDt = Math.min(0.25, (now - this.lastTime) / 1000);
      this.lastTime = now;
      this.tick(realDt, now);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  private tick(realDt: number, now: number): void {
    this.input.beginFrame();
    if (this.phase === 'playing' && this.world && this.mode && this.player) {
      for (let i = 1; i <= 8; i++) {
        if (this.input.pressed(`weapon${i}` as Action) && i - 1 < this.player.weapons.length) {
          this.player.weaponIndex = i - 1;
        }
      }
      if (now > this.inputLockUntil && this.input.pressed('pause')) this.pause();

      if (this.phase === 'playing') {
        const snap = this.sampleInput();
        this.acc = Math.min(this.acc + realDt, FIXED * MAX_STEPS);
        let steps = 0;
        while (this.acc >= FIXED && steps < MAX_STEPS) {
          this.world.update(FIXED, snap);
          this.mode.update(FIXED);
          if (steps === 0) {
            snap.firePressed = false;
            snap.abilityPressed = false;
            snap.weaponCycle = false;
          }
          this.acc -= FIXED;
          steps++;
        }
        this.camera.update(realDt, this.world.shakeAmount, this.world.shakeX, this.world.shakeY);
        const throttle = this.player.alive
          ? clamp(Math.hypot(this.player.vx, this.player.vy) / Math.max(1, this.player.speed), 0, 1)
          : 0;
        audio.updateEngine(throttle, realDt, this.player.boostActive);
        audio.updateMusic();
        if (this.mode.isOver) this.finishRun();
      }
    } else if ((this.phase === 'paused' || this.phase === 'results') && now > this.inputLockUntil) {
      if (this.input.pressed('pause')) {
        if (this.phase === 'paused') this.resume();
        else this.quitToMenu();
      }
    }

    this.ui.update(realDt, this.buildHudState());

    this.renderer.markFrame(realDt);
    if (this.world && this.phase !== 'menu' && this.phase !== 'boot') {
      this.renderer.render(this.world, this.renderOpts());
      if (this.save.save.settings.showMinimap && this.ui.minimapCanvas) {
        this.renderer.renderMinimap(this.ui.minimapCanvas, this.world, this.save.save.settings);
      }
    }

    this.input.endFrame();
  }

  private sampleInput(): PlayerInput {
    const inp = this.input;
    const p = this.player;
    const s = this.save.save.settings;
    const ax = inp.axis();
    let aimX = 0;
    let aimY = 0;
    let aimMode: 'mouse' | 'movement' = 'movement';
    this.aimPoint = null;
    if (p) {
      const useMouse = s.mouseAim && inp.mouseInside && s.controlScheme !== 'classic';
      if (useMouse) {
        const w = this.camera.screenToWorld(inp.mouseScreenX, inp.mouseScreenY);
        inp.setWorldMouse(w.x, w.y);
        aimX = w.x;
        aimY = w.y;
        aimMode = 'mouse';
        this.aimPoint = w;
      } else {
        const ga = inp.aimAxis();
        if (ga) {
          aimX = p.x + ga.x * 220;
          aimY = p.y + ga.y * 220;
          aimMode = 'mouse';
          this.aimPoint = { x: aimX, y: aimY };
        } else {
          aimX = p.x + ax.x * 120;
          aimY = p.y + ax.y * 120;
        }
      }
    }
    return {
      mx: ax.x,
      my: ax.y,
      aimX,
      aimY,
      fire: s.autoFire ? inp.isDown('fire') : inp.pressed('fire'),
      firePressed: inp.pressed('fire'),
      boost: inp.isDown('boost'),
      ability: inp.isDown('ability'),
      abilityPressed: inp.pressed('ability'),
      weaponCycle: inp.pressed('switchWeapon'),
      aimMode,
      classic: s.controlScheme === 'classic',
    };
  }

  private triggerAbility(): void {
    this.input.virtualAbility = true;
    setTimeout(() => (this.input.virtualAbility = false), 60);
  }

  private renderOpts(): RenderOpts {
    const meta = this.save.save.meta;
    const skin = COSMETICS.find((c) => c.kind === 'skin' && c.id === meta.skin);
    const chassis = CHASSIS[meta.chassis] ?? CHASSIS.ranger;
    const skinColors: TankColors = (skin?.colors as TankColors | undefined) ?? chassis.color;
    const theme = this.built?.theme ?? 'arid';
    return {
      settings: this.save.save.settings,
      skinColors,
      turretStyle: meta.turretStyle,
      baseDecor: meta.baseDecor,
      aimPoint: this.aimPoint,
      darkness: DARKNESS_BY_THEME[theme] ?? 0,
      time: this.world?.time ?? 0,
    };
  }

  private buildHudState(): HudState | null {
    if (!this.world || !this.mode || (this.phase !== 'playing' && this.phase !== 'paused' && this.phase !== 'results')) {
      return null;
    }
    return {
      world: this.world,
      mode: this.mode,
      player: this.player,
      lives: this.player?.lives ?? 0,
      fps: this.renderer.fps,
      showFps: this.save.save.settings.showFps,
      showMinimap: this.save.save.settings.showMinimap,
      hitmarkers: this.save.save.settings.hitmarkers,
      weaponSlots: this.player?.weapons ?? [],
      abilityKeyLabel: prettyKey(this.input.binds.ability?.[0]),
    };
  }

  /* ------------------------------------------------------------------ */
  /* run end + rewards                                                   */
  /* ------------------------------------------------------------------ */

  private finishRun(): void {
    const mode = this.mode;
    const world = this.world;
    const player = this.player;
    const rk = this.runKind;
    if (!mode || !world || !player || !rk) return;

    const settings = this.save.save.settings;
    const diff = getDifficulty(settings.difficulty);
    const result: RunResult = mode.result();
    result.difficulty = settings.difficulty;
    if (rk.type === 'campaign') {
      result.stageId = rk.stageId;
      result.stageName = getLevel(rk.stageId).name;
    }

    let rewards: RewardBreakdown | null = null;
    this.save.update((s) => {
      rewards = computeRewards(s, result, diff.scoreMul, diff.rewardMul);
      const st = s.stats;
      st.totalKills += result.kills;
      st.totalRuns += 1;
      st.totalPlaytime += result.time;
      st.shotsFired += world.shotsFired;
      st.shotsHit += world.shotsHit;
      st.damageDealt += result.damageDealt;
      st.powerupsCollected += result.powerups;
      st.bossesKilled += mode.bossesKilled;
      st.barrelsDetonated += world.barrelsDetonated;
      st.terrainDestroyed += world.terrainDestroyed;
      st.bestCombo = Math.max(st.bestCombo, result.bestCombo);
      st.deaths += Math.max(0, diff.lives - player.lives);
    });
    const rw = rewards!;

    audio.stopMusic();
    audio.play(result.victory ? 'level_complete' : 'level_failed', { volume: 1 });
    this.input.clearAll();
    this.phase = 'results';
    this.ui.setRunActive(false);
    this.inputLockUntil = performance.now() + 450;

    if (rk.type === 'campaign') {
      const nextStage = result.victory && rk.stageId < CAMPAIGN_STAGE_COUNT ? rk.stageId + 1 : null;
      this.pendingNextStage = nextStage;
      this.ui.screens.showResults(result, rw, nextStage);
    } else {
      const key = rk.type === 'bossrush' ? 'bossRush' : (rk.type as keyof typeof this.save.save.records);
      let board: ScoreEntry[] = [];
      let rank = -1;
      this.save.update((s) => {
        const rec = recordScore(s, key, {
          score: rw.totalScore,
          wave: result.waves + (result.victory ? 0 : 1),
          time: result.time,
          kills: result.kills,
          difficulty: settings.difficulty,
          chassis: s.meta.chassis,
          seed: rk.seed,
        });
        board = rec.list;
        rank = rec.rank;
      });
      this.ui.screens.showGameOver(result, rw, board, MODE_LABEL[rk.type] ?? rk.type, rank);
    }

    for (const u of rw.unlocks) this.ui.toast('UNLOCKED', u, 'good');
    if (rw.leveledUp) this.ui.toast('COMMANDER LEVEL UP', `You reached level ${rw.newLevel}`, 'good');
    this.save.flush();
    this.ui.screens.refreshMenu();
  }

  /* ------------------------------------------------------------------ */
  /* phase transitions                                                   */
  /* ------------------------------------------------------------------ */

  private togglePause(): void {
    if (this.phase === 'playing') this.pause();
    else if (this.phase === 'paused') this.resume();
  }

  private pause(): void {
    if (this.phase !== 'playing' || !this.world || !this.mode) return;
    this.phase = 'paused';
    this.input.clearAll();
    this.inputLockUntil = performance.now() + 300;
    audio.updateEngine(0, 0.016, false);
    audio.suspend();
    const stats: [string, string][] = [
      ['SCORE', formatNumber(this.world.score)],
      ['KILLS', String(this.world.kills)],
      ['WAVE', String(this.mode.waveIndex + 1)],
      ['TIME', formatTime(this.mode.elapsed)],
      ['ACCURACY', `${Math.round(this.world.accuracy * 100)}%`],
      ['COMBO', `×${this.world.bestCombo}`],
    ];
    this.ui.screens.showPause(stats);
    this.ui.focusPrimary();
  }

  resume(): void {
    if (this.phase !== 'paused') return;
    this.phase = 'playing';
    this.acc = 0;
    this.inputLockUntil = performance.now() + 300;
    this.ui.showGameUi();
    this.ui.setRunActive(true);
    void audio.resume();
  }

  restart(): void {
    if (!this.runKind) return;
    this.teardownRun();
    this.launchRun();
  }

  retry(): void {
    this.restart();
  }

  nextStage(): void {
    if (this.pendingNextStage != null && this.pendingNextStage <= CAMPAIGN_STAGE_COUNT) {
      const next = this.pendingNextStage;
      this.teardownRun();
      this.startCampaign(next);
    } else {
      this.quitToMenu();
    }
  }

  quitToMenu(): void {
    this.teardownRun();
    this.phase = 'menu';
    this.ui.setRunActive(false);
    this.ui.show('menu');
    audio.stopMusic();
  }

  openForge(): void {
    this.teardownRun();
    this.phase = 'menu';
    this.ui.setRunActive(false);
    this.ui.show('garage');
  }

  private teardownRun(): void {
    this.clearSubs();
    audio.updateEngine(0, 0.016, false);
    audio.stopMusic();
    this.world = null;
    this.mode = null;
    this.built = null;
    this.player = null;
    this.aimPoint = null;
    this.pendingNextStage = null;
    this.input.clearAll();
  }

  private primaryAction(): void {
    switch (this.phase) {
      case 'menu':
        const camp = this.save.save.campaign;
        const start =
          camp.completed.includes(0) || camp.highestStage > 1
            ? Math.min(camp.highestStage, CAMPAIGN_STAGE_COUNT)
            : 0;
        this.startCampaign(start);
        break;
      case 'results':
        if (this.pendingNextStage) this.nextStage();
        else this.restart();
        break;
      case 'paused':
        this.resume();
        break;
      default:
        break;
    }
  }

  /* ------------------------------------------------------------------ */
  /* UiHost passthroughs                                                 */
  /* ------------------------------------------------------------------ */

  toast(title: string, msg: string, kind: 'good' | 'bad' | '' = ''): void {
    this.ui.toast(title, msg, kind);
  }

  sfx(name: SfxName, volume = 1): void {
    audio.play(name, { volume });
  }

  /** Tear down listeners and stop the loop (used by tests / hot reload). */
  destroy(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.clearSubs();
    this.input.detach();
    this.ui.destroy();
    audio.stopMusic();
  }
}
