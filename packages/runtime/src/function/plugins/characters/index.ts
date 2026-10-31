/**
 * characters — one Character component for anything that walks (sdk/parallax/characters.pyi):
 * walk/run speeds, acceleration, air control, gravity, jumps with
 * coyote time and air jumps, slopes, steps and ground snapping, facing, riding moving
 * platforms, and the Landed / Jumped events — and the humanoid tier as opt-in data on the
 * same component: stances (the capsule's height), vault/climb traversals found by shapecasts,
 * swimming in a water plugin's volumes (the `water` service), free fall and the parachute,
 * holding items on Model sockets, carrying other entities, and Seats. It drives the
 * entity's Animator params and takes its "character" root motion; an Animator without a
 * base-layer graph gets its clips picked automatically (locomotion.ts: gaits, strafes,
 * turns, air, stride-matched rates). Garments and the Wardrobe (wardrobe.ts) dress a
 * body with skinned models posed by its skeleton (models/garments.ts). Moves go through the
 * physics3d service (Rapier's kinematic character controller) at use time; this plugin never
 * imports physics3d.
 *
 * The character's capsule (radius, stance height) stands on the entity origin. When the
 * entity also has a Collider, the capsule takes that collider's layer and collides_with, and
 * the Collider itself stays attached as authored (triggers and raycasts see both; events are
 * reported once per entity pair). A Character entity must not have a Rigidbody.
 *
 * It provides the `characters` service (function/services/characters.ts): what a character
 * is doing, for the viewmodel and camera rigs.
 *
 * One `characters()` value serves one kernel.
 */

import { fail } from '../../../core/index.js';
import type { Json } from '../../../resource/index.js';
import type { Kernel, KernelPlugin } from '../../kernel/index.js';
import { CHARACTERS_SERVICE } from '../../services/index.js';
import { characterComponents } from './components.js';
import { wardrobeComponents, Wardrobes } from './wardrobe.js';
import { CHARACTER, CHARACTER_EVENTS, Characters } from './motor.js';
import type { AttachToSocket, SavedCharacter } from './motor.js';

export { CHARACTER_SCHEMA, SEAT_SCHEMA } from './components.js';
export { CHARACTER, CHARACTER_EVENTS, COYOTE_TIME, EYE_RATE, SEAT } from './motor.js';
export type { AttachToSocket } from './motor.js';
export { CHARACTER_PARAMS } from './animate.js';
export { clipKey, decompose, LOCOMOTION_STATES, LocomotionSelector, resolveLocomotionClip, tuningFor } from './locomotion.js';
export type { LocomotionCommand, LocomotionInput, LocomotionParams, LocomotionState } from './locomotion.js';
export { GARMENT, GARMENT_SCHEMA, WARDROBE, WARDROBE_SCHEMA } from './wardrobe.js';
export { characterProblems, EYE_FRACTION, eyeHeight } from './rules.js';
export type { CharacterProblem } from './rules.js';
export { CARRY_RECORD, PARACHUTE_RECORD, SKYDIVE_RECORD, STANCES_RECORD, SWIMMING_RECORD, TRAVERSAL_RECORD } from './schemas.js';

export interface CharactersOptions {
  /**
   * Parents a held item to a socket of the holder's Model with `attach(child, socket=...)`'s
   * checks (the api layer supplies it). Without it, holding by an entity with a Model fails.
   */
  readonly attach?: AttachToSocket;
}

export function characters(options: CharactersOptions = {}): KernelPlugin {
  let motor: Characters | undefined;
  const current = (): Characters => {
    if (motor === undefined) fail('PP9160', 'The characters plugin is used before its kernel was built');
    return motor;
  };
  let wardrobes: Wardrobes | undefined;
  const dresser = (): Wardrobes => {
    if (wardrobes === undefined) fail('PP9160', 'The characters plugin is used before its kernel was built');
    return wardrobes;
  };
  let installedOn: Kernel | undefined;
  return {
    id: 'characters',
    components: [...characterComponents(current), ...wardrobeComponents(dresser)],
    events: Object.values(CHARACTER_EVENTS),
    install(kernel) {
      if (installedOn !== undefined) {
        fail('PP9161', 'This characters plugin is already installed in another kernel', { fix: 'Call characters() once per kernel.' });
      }
      installedOn = kernel;
      const created = new Characters(kernel, options.attach);
      motor = created;
      kernel.observeEntities({
        added: (records) => created.added(records),
        removed: (records) => created.removed(records),
        changed: (record) => created.changed(record),
      });
      kernel.provide(CHARACTERS_SERVICE, {
        view: (entity) => created.view(entity),
        sit: (entity, seat) => created.sit(entity, seat),
        leaveSeat: (entity) => {
          const fields = kernel.world.peek(entity)?.components.get(CHARACTER);
          return fields === undefined ? false : created.leaveSeat(entity, fields);
        },
      });
      kernel.addHook('physics', (dt) => created.step(dt));
      const dressing = new Wardrobes(kernel);
      wardrobes = dressing;
      kernel.addHook('ui', () => dressing.frame());
    },
    snapshot: () => current().snapshot() as unknown as Json,
    restore: (_kernel, saved) => current().restore(saved as unknown as SavedCharacter[]),
  };
}
