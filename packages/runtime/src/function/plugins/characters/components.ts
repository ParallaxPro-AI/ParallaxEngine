/** The `character` and `seat` components (sdk/parallax/characters.pyi): fields and methods. */

import { fail } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { componentEntity } from '../../kernel/index.js';
import type { ComponentDef, Fields } from '../../kernel/index.js';
import { describe, finite, splitKeywords, vec3 } from './args.js';
import type { Characters } from './motor.js';
import { CHARACTER, CHARACTER_SCHEMA, SEAT_COMPONENT } from './schemas.js';

export { CHARACTER_SCHEMA, SEAT_SCHEMA } from './schemas.js';

type Motor = () => Characters;

const STANCES = ['stand', 'crouch', 'prone'] as const;

function own(fields: unknown): EntityId {
  return componentEntity(fields as Fields);
}

function entityArg(motor: Motor, value: unknown, where: string): EntityId {
  const kernel = motor().kernel;
  const id = kernel.handles.unwrap(value);
  if (id === undefined || kernel.world.get(id) === undefined) {
    fail('PP3172', `${where} must be a live Entity, got ${describe(value)}`, { fix: 'Pass an entity that is in the world.' });
  }
  return id;
}

function wrapped(motor: Motor, id: EntityId | undefined): unknown {
  return id === undefined ? null : motor().kernel.handles.wrap(id);
}

function characterMethods(motor: Motor): object {
  return {
    get entity(): unknown {
      return motor().kernel.handles.wrap(own(this));
    },
    move(this: Fields, ...args: unknown[]): void {
      const { positional: p, keywords: k } = splitKeywords(args, 'move', ['direction', 'speed', 'run']);
      const speed = k['speed'];
      motor().move(own(this), vec3(p[0] ?? k['direction'], 'move direction'),
        speed === undefined || speed === null ? null : finite(speed, 'move(speed=)'), k['run'] === true);
    },
    jump(this: Fields, ...args: unknown[]): boolean {
      splitKeywords(args, 'jump', []);
      if (args.length > 0) fail('PP3030', 'jump() takes no arguments');
      return motor().jump(own(this), this);
    },
    launch(this: Fields, ...args: unknown[]): void {
      const { positional: p, keywords: k } = splitKeywords(args, 'launch', ['velocity']);
      motor().launch(own(this), vec3(p[0] ?? k['velocity'], 'launch velocity'));
    },
    knockback(this: Fields, ...args: unknown[]): void {
      const { positional: p, keywords: k } = splitKeywords(args, 'knockback', ['push', 'impulse']);
      if ('impulse' in k) {
        fail('PP3030', 'Character.knockback() impulse= was renamed to push= (a velocity change in m/s, not N·s)', {
          fix: 'Write knockback(push=v), or pass the velocity change positionally.',
        });
      }
      motor().knockback(own(this), vec3(p[0] ?? k['push'], 'knockback push'));
    },
    stop(this: Fields): void {
      motor().stop(own(this));
    },
    face(this: Fields, ...args: unknown[]): void {
      const { positional: p, keywords: k } = splitKeywords(args, 'face', ['yaw_deg']);
      motor().face(own(this), finite(p[0] ?? k['yaw_deg'], 'face yaw_deg'));
    },
    teleport(this: Fields, ...args: unknown[]): void {
      const { positional: p, keywords: k } = splitKeywords(args, 'teleport', ['position', 'yaw']);
      const yaw = k['yaw'];
      motor().teleport(own(this), vec3(p[0] ?? k['position'], 'teleport position'),
        yaw === undefined || yaw === null ? undefined : finite(yaw, 'teleport(yaw=)'));
    },
    set_stance(this: Fields, ...args: unknown[]): boolean {
      const { positional: p, keywords: k } = splitKeywords(args, 'set_stance', ['stance']);
      const stance = p[0] ?? k['stance'];
      if (typeof stance !== 'string' || !(STANCES as readonly string[]).includes(stance)) {
        fail('PP3175', `set_stance() takes "stand", "crouch" or "prone", got ${describe(stance)}`);
      }
      return motor().setStance(own(this), this, stance as typeof STANCES[number]);
    },
    release_parachute(this: Fields): boolean {
      return motor().releaseParachute(own(this));
    },
    hold(this: Fields, ...args: unknown[]): boolean {
      const { positional: p, keywords: k } = splitKeywords(args, 'hold', ['item', 'socket']);
      const socket = k['socket'] ?? null;
      if (socket !== null && typeof socket !== 'string') fail('PP3172', `hold(socket=) must be a socket name, got ${describe(socket)}`);
      return motor().hold(own(this), this, entityArg(motor, p[0] ?? k['item'], 'hold item'), socket as string | null);
    },
    drop(this: Fields): unknown {
      return motor().drop(own(this));
    },
    throw(this: Fields, ...args: unknown[]): unknown {
      const { positional: p, keywords: k } = splitKeywords(args, 'throw', ['velocity']);
      return motor().throw(own(this), vec3(p[0] ?? k['velocity'], 'throw velocity'));
    },
    place(this: Fields, ...args: unknown[]): unknown {
      const { positional: p, keywords: k } = splitKeywords(args, 'place', ['position', 'yaw']);
      return motor().place(own(this), vec3(p[0] ?? k['position'], 'place position'), finite(k['yaw'] ?? 0, 'place(yaw=)'));
    },
    lift(this: Fields, ...args: unknown[]): boolean {
      const { positional: p, keywords: k } = splitKeywords(args, 'lift', ['other']);
      return motor().lift(own(this), this, entityArg(motor, p[0] ?? k['other'], 'lift other'));
    },
    put_down(this: Fields): unknown {
      return motor().putDown(own(this), this);
    },
    sit(this: Fields, ...args: unknown[]): boolean {
      const { positional: p, keywords: k } = splitKeywords(args, 'sit', ['seat']);
      return motor().sit(own(this), entityArg(motor, p[0] ?? k['seat'], 'sit seat'));
    },
    leave_seat(this: Fields): boolean {
      return motor().leaveSeat(own(this), this);
    },
    get grounded(): boolean {
      return motor().state(own(this)).grounded;
    },
    get ground(): unknown {
      return wrapped(motor, motor().state(own(this)).ground);
    },
    get velocity(): unknown {
      return motor().velocity(own(this));
    },
    get vehicle(): unknown {
      return wrapped(motor, motor().vehicleOf(own(this)));
    },
    get motion(): string {
      return motor().state(own(this)).motion;
    },
    get stance(): string {
      return motor().state(own(this)).stance;
    },
    get eye(): unknown {
      return motor().eye(own(this));
    },
    get ledge(): string | null {
      return motor().ledge(own(this), this as unknown as Fields);
    },
    get held(): unknown {
      return wrapped(motor, motor().state(own(this)).held);
    },
    get carried(): unknown {
      return wrapped(motor, motor().state(own(this)).carried);
    },
    get carrier(): unknown {
      return wrapped(motor, motor().carrierOf(own(this)));
    },
    get seat(): unknown {
      return wrapped(motor, motor().state(own(this)).seat?.seat);
    },
  };
}

export function characterComponents(motor: Motor): ComponentDef[] {
  return [
    { id: CHARACTER, schema: CHARACTER_SCHEMA, methods: characterMethods(motor) },
    SEAT_COMPONENT,
  ];
}
