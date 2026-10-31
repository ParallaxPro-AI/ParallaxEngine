/**
 * plugins/local_players — local multiplayer on one device (sdk/parallax/plugins.pyi
 * `local_players`). It provides the `players` service
 * (function/services/players.ts): the api layer builds `ctx.players`, `Player.entity` and
 * the input engine's seats from it.
 *
 * Seats. Every seat is in play for the whole game (`seats=N`; the SDK has no join/leave).
 * Seat i reads `controls[i]`; every seat reads the keyboard (each set binds its own keys),
 * seat 0 also the mouse and touch controls, and seat i gamepad i. With
 * `controls="gamepads"` seat i reads gamepad i only, and seat 0 also the keyboard, mouse
 * and touch (so menus work at a desk).
 *
 * Spawning. When a scene with `PlayerStart` placements starts (before the game's systems
 * start), each seat gets an entity from `player_prefab`, owned by the seat, at the
 * PlayerStart for its seat — else at an unused `seat=-1` start. A scene without any
 * PlayerStart (a title screen) spawns nothing. With split screen each seat also gets a
 * camera from `camera_prefab`, owned by the seat (so it is that seat's `ctx.camera.main`),
 * following the seat's entity, in the seat's viewport:
 *
 *   vertical    side by side, seat 0 on the left
 *   horizontal  stacked, seat 0 on top
 *   grid        ceil(√n) columns, filled row by row
 *   none        one shared view: no per-seat cameras (camera_prefab not allowed)
 *
 * State. A seat's entity is the live entity it owns that came from `player_prefab`, read
 * from the world, so snapshots and saves need nothing of their own here.
 */

import { fail } from '../../../core/index.js';
import { resolvePrefab } from '../../../resource/index.js';
import type { EntityId } from '../../../core/index.js';
import type { EntityRecord, Kernel, KernelPlugin, SystemDef } from '../../kernel/index.js';
import { PLAYERS_SERVICE } from '../../services/index.js';
import type { PlayerSeat, PlayersService, SeatInput } from '../../services/index.js';

/** Engine component ids this plugin reads and writes (the visuals plugin defines them; SDK names). */
const PLAYER_START = 'player_start';
const CAMERA = 'camera';

export const SPLIT_SCREENS = ['none', 'vertical', 'horizontal', 'grid'] as const;
export type SplitScreen = (typeof SPLIT_SCREENS)[number];

export interface LocalPlayersOptions {
  readonly seats: number;
  readonly playerPrefab: string;
  /** Per-seat controls (opaque action-set declarations, one per seat), or "gamepads". */
  readonly controls: readonly unknown[] | 'gamepads';
  readonly cameraPrefab: string | null;
  readonly splitScreen: SplitScreen;
}

/** Seat i's viewport `[x, y, width, height]` (fractions of the screen, y from the top). */
export function viewport(split: SplitScreen, seat: number, seats: number): number[] {
  switch (split) {
    case 'none': return [0, 0, 1, 1];
    case 'vertical': return [seat / seats, 0, 1 / seats, 1];
    case 'horizontal': return [0, seat / seats, 1, 1 / seats];
    case 'grid': {
      const cols = Math.ceil(Math.sqrt(seats));
      const rows = Math.ceil(seats / cols);
      return [(seat % cols) / cols, Math.floor(seat / cols) / rows, 1 / cols, 1 / rows];
    }
  }
}

function seatInput(options: LocalPlayersOptions, seat: number): SeatInput {
  if (options.controls === 'gamepads') {
    const first = seat === 0;
    return { keyboard: first, mouse: first, touch: first, gamepad: seat };
  }
  return { keyboard: true, mouse: seat === 0, touch: seat === 0, gamepad: seat, controls: options.controls[seat] };
}

function checkOptions(options: LocalPlayersOptions): void {
  if (!Number.isInteger(options.seats) || options.seats < 1) {
    fail('PP3960', `local_players(seats=${String(options.seats)}): seats must be an int of 1 or more`);
  }
  if (options.controls !== 'gamepads' && options.controls.length !== options.seats) {
    fail('PP3960', `local_players(seats=${options.seats}) has ${options.controls.length} controls`, {
      fix: `Give one Actions class per seat (controls=[P1Controls, P2Controls, ...]), or controls="gamepads".`,
    });
  }
  if (!SPLIT_SCREENS.includes(options.splitScreen)) {
    fail('PP3960', `local_players(split_screen=${JSON.stringify(options.splitScreen)}) is not a layout`, { fix: `Use one of: ${SPLIT_SCREENS.join(', ')}.` });
  }
  if (options.splitScreen === 'none' && options.cameraPrefab !== null) {
    fail('PP3960', 'local_players(split_screen="none") shares one view, so it takes no camera_prefab', {
      fix: 'Pick a split_screen layout for per-seat cameras, or drop camera_prefab and place one camera in the scene.',
    });
  }
}

export class LocalPlayers implements PlayersService {
  readonly #options: LocalPlayersOptions;
  readonly #seats: readonly PlayerSeat[];
  #kernel: Kernel | undefined;

  constructor(options: LocalPlayersOptions) {
    checkOptions(options);
    this.#options = options;
    this.#seats = Array.from({ length: options.seats }, (_, index) => ({
      index, id: `local-${index}`, name: `Player ${index + 1}`, local: true, input: seatInput(options, index),
    }));
  }

  install(kernel: Kernel): void {
    if (this.#kernel !== undefined) {
      fail('PP3960', 'This local_players plugin is already installed in another kernel', { fix: 'Call local_players(...) once per game.' });
    }
    for (const [what, prefab] of [['player_prefab', this.#options.playerPrefab], ['camera_prefab', this.#options.cameraPrefab]] as const) {
      if (prefab !== null && !kernel.project.prefabs.has(prefab)) {
        fail('PP3961', `local_players(${what}=...) names prefab "${prefab}", which the project doesn't have`, {
          fix: `Create prefabs/${prefab}.prefab.json, or pass an existing Prefabs.<id>.`,
        });
      }
    }
    const camera = this.#options.cameraPrefab;
    if (camera !== null && resolvePrefab(kernel.project, camera).components[CAMERA] === undefined) {
      fail('PP3961', `local_players(camera_prefab=...) prefab "${camera}" has no camera component`, { fix: `Add a "camera" component to prefabs/${camera}.prefab.json.` });
    }
    this.#kernel = kernel;
    kernel.provide(PLAYERS_SERVICE, this);
  }

  seats(): readonly PlayerSeat[] {
    return this.#seats;
  }

  entity(seat: number): EntityId | null {
    const kernel = this.#kernel;
    if (kernel === undefined) return null;
    for (const record of kernel.world.live()) {
      if (record.owner === seat && record.prefab === this.#options.playerPrefab && record.parent === null) return record.id;
    }
    return null;
  }

  /** The scene's PlayerStarts, in spawn order. */
  #starts(kernel: Kernel): { record: EntityRecord; seat: number }[] {
    const starts: { record: EntityRecord; seat: number }[] = [];
    for (const record of kernel.world.live()) {
      const fields = record.components.get(PLAYER_START);
      if (fields !== undefined) starts.push({ record, seat: fields['seat'] as number });
    }
    return starts;
  }

  /** A scene started: spawn each seat at its PlayerStart (none when the scene has none). */
  spawnSeats(): void {
    const kernel = this.#kernel!;
    const starts = this.#starts(kernel);
    if (starts.length === 0) return;
    const used = new Set<EntityRecord>();
    const scene = kernel.scene?.id ?? '?';
    for (const seat of this.#seats) {
      if (this.entity(seat.index) !== null) continue;
      const start = starts.find((s) => s.seat === seat.index && !used.has(s.record)) ?? starts.find((s) => s.seat === -1 && !used.has(s.record));
      if (start === undefined) {
        fail('PP3962', `Scene "${scene}" has PlayerStarts, but none for seat ${seat.index}`, {
          fix: `Place a PlayerStart with "seat": ${seat.index} (or a free "seat": -1) in scene "${scene}".`,
        });
      }
      used.add(start.record);
      const node = start.record.transform;
      const at = node.worldPosition();
      const rotation = node.worldRotation().to_euler();
      const entity = kernel.spawn(this.#options.playerPrefab, { at: [at.x, at.y, at.z], rotation: [rotation.x, rotation.y, rotation.z] }, { owner: seat.index });
      if (this.#options.cameraPrefab !== null) this.#spawnCamera(kernel, seat.index, entity, at.x, at.y, at.z);
    }
  }

  #spawnCamera(kernel: Kernel, seat: number, target: EntityRecord, x: number, y: number, z: number): void {
    const prefab = this.#options.cameraPrefab!;
    kernel.spawn(prefab, { at: [x, y, z] }, {
      owner: seat,
      components: { [CAMERA]: { follow: kernel.handles.wrap(target.id), viewport: viewport(this.#options.splitScreen, seat, this.#seats.length) } },
    });
  }
}

export interface LocalPlayersPlugin extends KernelPlugin {
  readonly players: LocalPlayers;
}

export function localPlayers(options: LocalPlayersOptions): LocalPlayersPlugin {
  const players = new LocalPlayers(options);
  const spawner: SystemDef = {
    id: 'local_players',
    scenes: [],
    handlers: [],
    create: () => ({ start: () => players.spawnSeats() }),
  };
  return {
    id: 'local_players',
    players,
    systems: [spawner],
    install: (kernel) => players.install(kernel),
  };
}

