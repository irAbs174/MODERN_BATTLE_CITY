# MODERN_BATTLE_CITY

A polished, modern reimagining of the NES classic **Battle City**  top-down tank
combat, destructible terrain, a protected HQ, and escalating enemy waves  rebuilt
from scratch with meta-progression, five game modes, and **procedural gameplay art**.
Every sprite is drawn procedurally to canvas and every sound is synthesised in the
browser with the Web Audio API. Raster files on the About screen (developer
portrait and a historical NES title clip) are the only exception.

Built with **Vite + TypeScript + Canvas 2D**. No game engine, no audio files, no
copyrighted material.

![Logic in Motion](https://tank.damerchi.ir/battle-city-nes.gif)


---

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server with HMR (binds `0.0.0.0:5173`) |
| `npm run build` | Type-checks then builds to `dist/` (~88 kB gzipped) |
| `npm run preview` | Serves the production build |
| `npm test` | Runs the Vitest suite (154 tests, headless) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run typecheck` | `tsc --noEmit` under strict mode |

### Docker

```bash
docker compose up --build
# http://127.0.0.1:17480
```

The default image is a multi-stage Node 22 build (tests + `vite build`) served
by nginx inside the container. Compose publishes **localhost only** on port
`17480` so it never claims host ports 80/443.

---

## Production (GitHub Actions)

Pushes to `main` run tests and `vite build` on GitHub-hosted runners, rsync the
tree **including `dist/`** to `/opt/tankforge`, then
`docker compose -p tankforge -f docker-compose.yml -f docker-compose.prod.yml up -d --build`.
The production overlay uses `Dockerfile.prebuilt` (nginx + `dist` only) so the
shared host never needs npm registry access inside Docker.

Host nginx should proxy **only** `tank.damerchi.ir` to `http://127.0.0.1:17480`
using `deploy/nginx.host.conf`. Do not edit other vhosts or the global
`nginx.conf`.

Configure these **repository secrets** (never commit them):

| Secret | Meaning |
| --- | --- |
| `SSH_PRIVATE_KEY` | Dedicated ed25519 deploy key |
| `SSH_HOST` | Production host |
| `SSH_USER` | SSH user (deploy is expected as the account that owns `/opt/tankforge`) |
| `SSH_KNOWN_HOSTS` | Output of `ssh-keyscan -H <host>` |

First-time host setup: install Docker only if missing, create `/opt/tankforge`,
append the deploy public key to `authorized_keys` without removing other keys,
enable the isolated nginx site, then `certbot --nginx -d tank.damerchi.ir` only.

---

## Controls

### Keyboard + mouse (default "modern" scheme)

| Action | Keys |
| --- | --- |
| Drive | `W` `A` `S` `D`  full 8-directional movement |
| Aim turret | Mouse (independent of hull, free 360°) |
| Fire | `Space` or Left Mouse |
| Special ability | `E` or Right Mouse |
| Cycle weapon | `Q` or Middle Mouse |
| Select weapon 1–8 | `1` … `8` |
| Boost | `Shift` (drains an energy meter) |
| Pause | `Esc` or `P` |

### Classic scheme

Settings → **Control scheme → Classic** switches to the authentic 4-direction,
hull-locked turret handling of the original game.

**Also supported:** gamepad (dual-stick), and on-screen touch controls with a
virtual stick + fire/ability/boost buttons (auto-shown on touch devices, or forced
via Settings → Touch controls).

On the menus, the sequence **Up, Up, Down, Down, Left, Right, Left, Right, Q, Q**
unlocks the developer kit (every stage, weapon, chassis, ability and cosmetic, plus
credits).

---

## Features

### Combat & terrain
- **8 weapons**  Cannon, Rapid, Heavy, Flamethrower, Plasma, Rocket, Railgun, Mortar
  (each with distinct projectiles: piercing, splash, arcing lobbed shells, cone flame,
  damage-over-time burn).
- **10 special abilities**  Dash, Mine, Airstrike, EMP, Time-slow, Shield, Drone,
  Laser, Chrono and more, on a cooldown meter.
- Arenas mix **destructible brick**, **hardened stone**, and **metal plate**, plus
  elemental ground: **ice** (low traction), **water** (treads cannot cross; hover can),
  **forest** (blocks sight and conceals tanks), **sand** (slow going) and **lava**
  (burns hulls). The arena edge still stops tanks and shots.
- **The HQ (base)** must be defended  lose it and the run is over. It can be upgraded
  with more HP and up to 4 auto-firing turrets.

### Enemies & AI
- **12 enemy types** across distinct AI archetypes: Scout, Raider, Assault, Sniper,
  Missile, Shield, Heavy, Hunter, Elite, Wraith, plus two multi-phase bosses 
  **Fortress** and **Colossus**.
- Flow-field pathfinding to both the player and the HQ, line-of-sight checks,
  engagement-range preferences, flanking/weaving, spawn protection, elite variants,
  and boss enrage phases.

### Game modes
| Mode | Goal |
| --- | --- |
| **Campaign** | Training stage 0, then 24 handcrafted stages across 6 themed warzones (Arid Basin, Tundra Front, Foundry Sector, Blackout Grid, Verdant Reach, Ember Wastes), with boss stages every 4th numbered mission |
| **Endless** | Procedurally generated arena, infinite escalating waves, arena mutates every 5 waves |
| **Survival** | No HQ to defend  pure endurance |
| **Challenge** | Two random modifiers reshuffle the rules each seed |
| **Boss Rush** | Five back-to-back super-heavies; hull restored between fights |

Procedural level generation is **fully seeded and deterministic**, and a budgeted
wave director composes enemy mixes that unlock tougher units as waves climb.

### Meta-progression
XP and levels, credits, 6 upgrade tracks × 6 tiers (Engine, Armor, Cannon, Targeting,
Shield, Utility), 6 chassis with distinct handling (including hovering and off-road),
weapon/ability unlocks gated by campaign progress, 3-star stage ratings, per-mode
leaderboards, and cosmetic unlocks (paint jobs, shell trails, turret styles, HQ decor).

### Presentation & feel
- Procedurally synthesised **audio**: distinct weapon voices, explosions, UI blips and
  six per-theme music beds  all generated at runtime, no samples.
- Particle system with fire, smoke, debris, shards, shockwave rings, floating damage
  numbers, muzzle flashes, recoil and squash.
- Camera zoom, shake and hit-stop; screen flash on big detonations.
- HUD with wave/objective tracking, boss health pips, minimap, FPS counter, and a
  full menu/garage/settings/results screen flow.
- Object pooling for projectiles and particles; fixed-timestep simulation (60 Hz) with
  an accumulator, targeting a stable 60 FPS.

### Accessibility & settings
Screen-shake toggle and intensity slider, **reduced motion**, **colourblind mode**,
damage numbers, hitmarkers, 4 difficulty presets (Recruit / Veteran / Elite /
Nightmare), quality tiers, FPS and minimap toggles, mouse-aim and auto-fire toggles,
and rebindable keys.

### Persistence
Versioned save system on `localStorage` with an in-memory fallback, deep-merged
against defaults and forward-migrated so old saves never break, plus base64
**export/import** strings for backups.

---

## Architecture

The simulation is completely decoupled from rendering and the DOM, which is why the
entire game logic can be unit-tested headlessly in Node.

```
src/
  core/       math, seeded Rng, EventBus, object Pool, SpatialHash, config/difficulties
  world/      terrain tables, Grid (collision/raycast/destruction), procedural LevelGen,
              24 handcrafted campaign levels plus a training stage, LevelBuilder, World (the simulation orchestrator)
  data/       weapons, abilities, enemies, powerups, progression (chassis/upgrade tracks)
  entities/   Tank base → PlayerTank / EnemyTank, Projectile, Base + Turret, PowerUp
  ai/         FlowField pathfinding, EnemyBrain decision-making
  systems/    ParticleSystem
  modes/      GameMode base + Campaign / Endless / Survival / BossRush / Challenge
  meta/       SaveSystem (persistence, migration), Progression (XP, rewards, unlocks)
  input/      InputManager  keyboard, mouse, gamepad and touch unified into one state
  audio/      AudioManager  procedural Web Audio synthesis
  render/     Camera, TerrainLayer (cached offscreen tiles), sprite painters, Renderer
  ui/         Hud, Screens, TouchControls, UIManager
  Game.ts     fixed-timestep loop + phase machine, implements the UiHost contract
```

`World` owns all simulation state and publishes an `EventBus<GameEvents>`; the
Renderer, AudioManager and HUD simply subscribe. Particles live inside the simulation
so replays and tests stay deterministic.

---

## Tests

```bash
npm test     # 154 tests, ~2.7s
```

| Suite | Coverage |
| --- | --- |
| `math.test.ts` | interpolation, angle wrapping, geometry overlap, swept segment-vs-AABB, formatting, seeded RNG determinism |
| `grid.test.ts` | grid dimensions, open-ground movement, arena-edge collision, DDA raycast and line of sight |
| `levelgen.test.ts` | generator determinism and validity, wave-director budgets and boss waves, level building, stage scaling |
| `world.test.ts` | spawning, firing, damage/kills/combo/scoring, spawn protection, terrain destruction, HQ damage and destruction events, power-ups, player death, tank separation |
| `progression.test.ts` | XP curve, reward computation and star ratings, unlock gating, garage purchases, leaderboards, campaign progression |
| `save.test.ts` | defaults, persistence, migration of corrupt/out-of-range saves, export/import round-trip, score submission |
| `modes.test.ts` | intro → wave flow, victory/defeat conditions, per-mode rules, modifier determinism |
| `data.test.ts` | content integrity: every weapon/ability/enemy/chassis/power-up/level is well-formed and cross-references resolve |

Writing these caught two genuine simulation bugs that were fixed as part of this work:

1. **`Grid.raycast` overshoot**  the DDA walk compared a normalised `0..1` travel
   parameter against the segment length in world units, so rays never terminated at
   their endpoint and reported phantom "steel" hits past the target. This silently
   broke line-of-sight (AI concluded a wall *behind* its target blocked sight) and
   produced wrong hit coordinates.
2. **`World.separateTank` aliased the live enemy array**  `const all = this.enemies`
   followed by `all.push(this.player)` appended the **player** into `world.enemies` on
   every call. The main update loop then iterated the player as an enemy and called
   `player.update(world, dt)` with no input object, throwing a `TypeError` mid-frame 
   while also letting the AI target, count and collide with the player as a hostile,
   and growing the array unboundedly every frame. Fixed by extracting the pair
   resolution into a private helper so no combined array is ever built.

---

## Known limitations

- **No networking.** Everything is single-player and local; leaderboards are per-device.
- **IndexedDB is not used.** Saves go to `localStorage` (with an in-memory fallback),
  which is synchronous and quota-limited  fine for this payload, but it blocks the
  main thread on write. Writes are debounced to mitigate this.
- **Touch controls are functional, not tactile.** No haptics, and the virtual stick is
  a fixed-position overlay rather than a floating one anchored where you first touch.
- **Procedurally generated arenas have no authored wave tables.** They use the budgeted
  wave director, which is balanced but less hand-tuned than the 24 campaign stages.
- **Renderer is Canvas 2D.** It hits 60 FPS comfortably at typical particle counts, but
  there is no WebGL fallback for very low-end devices beyond the quality presets.
- **No tutorial level.** Onboarding is a tooltip tip per stage plus a readable HUD.

## Possible next steps

- Floating touch stick, haptic feedback, and a mobile-optimised HUD layout.
- IndexedDB storage adapter behind the existing `SaveSystem` interface for larger saves
  and async writes.
- Daily/weekly seeded challenge with a shared seed and a ghost replay of your best run.
- Replay system  the simulation is already deterministic and seeded, so recording an
  input stream would be enough.
- WebGL renderer for particle-heavy scenes, and a proper entity-component split if the
  entity variety keeps growing.
- Localisation pass (all strings are currently inline English).
- More bosses and a co-op local-multiplayer mode (the input layer already supports
  gamepads, so a second `PlayerTank` is mostly a UI problem).

---

## Developer

**Abbas Damerchi**  Senior Full-Stack Software Engineer.

Building distributed systems, automated e-commerce platforms and FinTech products.

- **Portfolio:** [damerchi.ir](https://damerchi.ir)

### Socials

- [YouTube](https://YouTube.com/@Unique_Sources)
- [X](https://x.com/abbasdamerchi)
- [Facebook](https://www.facebook.com/abbasDamerchilo/)
- [Instagram](https://www.instagram.com/irAbs174)
- [Reddit](https://www.reddit.com/user/abbas-damerchi/)
- [GitHub](https://Github.com/irAbs174)
- [LinkedIn](https://LinkedIn.com/in/abbas-damerchi)
- [Medium](https://abbas-damerchi.Medium.com)
- [Blogsky](https://nahad1.blogsky.com/)
- [Discord](https://discord.gg/DeHWVZRKS4)
- [Telegram](https://t.me/Unique_Sources)
- [Blogspot](https://unique-sources.blogspot.com/)

---

## Credits

An original homage to [*Battle City*](https://en.wikipedia.org/wiki/Battle_City)
(Namco, 1985). TANKFORGE is a modern, free rebuild of that classic  the source
will be public on [GitHub](https://Github.com/irAbs174) soon. This project shares
no code, art, audio or other assets with the original; the visual identity, audio
synthesis, level designs and game systems are all new work created for this
repository. The NES title-screen clip on the About page is shown only as a
historical reference.
