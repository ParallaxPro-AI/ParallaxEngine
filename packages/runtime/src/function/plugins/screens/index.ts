/**
 * screens — panels on in-world screens (sdk/parallax/screens.pyi). A `Screen` entity shows
 * one `@ui` panel on a `size` rectangle in its local x/y plane, facing +z (put it on a
 * monitor model's face, a cabinet's glass, a wall). The panel is the same kind of panel a
 * HUD uses — markup, `state()`, actions — with the screen's entity as its subject, one
 * instance per screen, so ten terminals each show their own state.
 *
 * Each frame, in the kernel's 'ui' hook:
 *   1. a pointer press (from the host: the camera's ray through the pointer) that hits a
 *      screen quad becomes a press at that texel; what the surface says is under it runs
 *      as a click of the panel's action — the click is consumed;
 *   2. every screen that is on has its panel's state evaluated and is presented (core
 *      `ScreenSurface`); it is due for a redraw on its first frame and whenever its state
 *      changed, at most `fps` times a second of game time.
 * Drawing: the `screens` service hands render3d one unlit quad per screen sampling the
 * texture `screen:<entity>` (services/screens.ts), `brightness` times its color.
 */

import { fail, Vec2, Vec3 } from '../../../core/index.js';
import type { EntityId, Geometry3d, Material3d, MeshBatch, ScreenSurface, UiValueRules } from '../../../core/index.js';
import { componentEntity, t } from '../../kernel/index.js';
import type { ComponentDef, EntityRecord, Fields, Kernel, KernelPlugin, Schema } from '../../kernel/index.js';
import { SCREENS_SERVICE } from '../../services/index.js';

export const SCREEN = 'screen';

export const SCREEN_SCHEMA: Schema = {
  /** The `@ui` panel's id (Python: the Panel class). */
  panel: t.string(),
  size: t.vec2({ default: new Vec2(1.6, 0.9) }),
  resolution: t.vec2({ default: new Vec2(512, 288) }),
  fps: t.number({ default: 10, min: 0.1, max: 60 }),
  on: t.bool({ default: true }),
  interactive: t.bool({ default: true }),
  brightness: t.number({ default: 1, min: 0 }),
  double_sided: t.bool({ default: false }),
};

/** A panel as the screens plugin runs it; the api layer builds these from `@ui` declarations. */
export interface ScreenPanelHost {
  readonly id: string;
  readonly html: string;
  /** A fresh panel instance for one screen (its subject is the screen's entity handle). */
  create(subject: unknown): object;
  state(instance: object): Readonly<Record<string, unknown>>;
  enabled(): Readonly<Record<string, boolean>>;
  /** Run an action as the panel's buttons would (commands included). PP2082 for an unknown one. */
  perform(instance: object, action: string, data: Readonly<Record<string, unknown>>, seat: number): void;
}

export interface ScreenPointer {
  readonly origin: Vec3;
  readonly direction: Vec3;
  readonly seat: number;
  /** Mark the press handled (mouse-bound actions don't also fire). */
  consume(): void;
}

export interface ScreensHost {
  panel(kernel: Kernel, id: string): ScreenPanelHost;
  /** This frame's pointer press as a world ray, or null when nothing was pressed. */
  press(kernel: Kernel): ScreenPointer | null;
  locale(kernel: Kernel): { readonly language: string; readonly strings: Readonly<Record<string, string>> };
  /** How state values read as text and conditions (the game language's rules). */
  values(kernel: Kernel): UiValueRules;
}

export interface ScreensPlugin extends KernelPlugin {
  /** Draw on the platform's screen surface (none: panels run, nothing is drawn). */
  connect(surface: ScreenSurface): void;
  /** Where a world ray meets a screen that takes presses: the nearest, as texel coordinates. */
  pick(origin: Vec3, direction: Vec3): { entity: EntityId; x: number; y: number; distance: number } | undefined;
}

interface Live {
  readonly panel: string;
  readonly instance: object;
  /** Game time of the last redraw, and the state drawn then (JSON). */
  drawnAt: number;
  drawn: string;
}

export const QUAD: Geometry3d = {
  id: 'screens:quad',
  positions: new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  // Read from the front: a viewer at +z looks down -z, so in this left-handed space their
  // right is local -x. The panel's left edge (u = 0) is therefore at +x, its top (v = 0) at +y.
  uvs: new Float32Array([1, 1, 0, 1, 0, 0, 1, 0]),
  // Counter-clockwise seen from +z.
  indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  joints: null, weights: null, colors: null,
  min: [-0.5, -0.5, 0], max: [0.5, 0.5, 0],
};

function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (v instanceof Map ? Object.fromEntries(v) : v instanceof Set ? [...v] : (typeof v === 'object' && v !== null && typeof (v as { toJSON?: unknown }).toJSON === 'function') ? (v as { toJSON(): unknown }).toJSON() : v)) ?? 'null';
}

export function screens(options: { readonly host: ScreensHost }): ScreensPlugin {
  let surface: ScreenSurface | undefined;
  let installed: Kernel | undefined;
  const live = new Map<EntityId, Live>();
  const materials = new Map<string, Material3d>();
  const kernelOf = (): Kernel => {
    if (installed === undefined) fail('PP9337', 'screens is used before its kernel was built');
    return installed;
  };
  const name = (r: EntityRecord): string => `entity ${r.placedId ?? r.prefab ?? r.id}`;

  const ensure = (kernel: Kernel, record: EntityRecord, fields: Fields): Live => {
    const panelId = fields['panel'] as string;
    let entry = live.get(record.id);
    if (entry === undefined || entry.panel !== panelId) {
      const host = options.host.panel(kernel, panelId);
      entry = { panel: panelId, instance: host.create(kernel.handles.wrap(record.id)), drawnAt: -Infinity, drawn: '' };
      live.set(record.id, entry);
    }
    return entry;
  };

  const texels = (fields: Fields, where: string): [number, number] => {
    const r = fields['resolution'] as Vec2;
    const w = Math.round(r.x);
    const h = Math.round(r.y);
    if (!(w >= 16 && h >= 16 && w <= 2048 && h <= 2048)) {
      fail('PP3338', `${where}.resolution is (${r.x}, ${r.y})`, { fix: 'Give whole numbers of texels from 16 to 2048 on each side, e.g. (512, 288).' });
    }
    return [w, h];
  };

  /** Where a world ray meets a screen's quad, in texels; undefined when it misses. */
  const hitQuad = (record: EntityRecord, fields: Fields, origin: Vec3, direction: Vec3): { x: number; y: number; distance: number } | undefined => {
    const t = record.transform;
    const o = t.toLocal(origin);
    const d = t.toLocal(origin.__add__(direction)).__sub__(o);
    if (Math.abs(d.z) < 1e-12) return undefined;
    const s = -o.z / d.z;
    if (!(s >= 0)) return undefined;
    // Only the front, unless double-sided.
    if (fields['double_sided'] !== true && d.z > 0) return undefined;
    const size = fields['size'] as Vec2;
    const u = 0.5 - (o.x + d.x * s) / size.x; // the viewer's left is local +x (see QUAD)
    const v = 0.5 - (o.y + d.y * s) / size.y;
    if (u < 0 || u > 1 || v < 0 || v > 1) return undefined;
    const [w, h] = texels(fields, `${name(record)} screen`);
    const world = t.toWorld(new Vec3(o.x + d.x * s, o.y + d.y * s, 0));
    return { x: Math.min(w - 1, Math.floor(u * w)), y: Math.min(h - 1, Math.floor(v * h)), distance: world.__sub__(origin).length() };
  };

  const pick = (origin: Vec3, direction: Vec3): { entity: EntityId; x: number; y: number; distance: number } | undefined => {
    const kernel = kernelOf();
    let best: { entity: EntityId; x: number; y: number; distance: number } | undefined;
    for (const [id, found] of kernel.world.query([SCREEN])) {
      const fields = found!;
      const record = kernel.world.get(id)!;
      if (fields['on'] !== true || fields['interactive'] !== true || !record.visible) continue;
      const hit = hitQuad(record, fields, origin, direction);
      if (hit !== undefined && (best === undefined || hit.distance < best.distance)) best = { entity: id, ...hit };
    }
    return best;
  };

  /** Press texel (x, y) of a screen: run what's under it. */
  const press = (kernel: Kernel, id: EntityId, x: number, y: number, seat: number): boolean => {
    if (surface === undefined) return false;
    const record = kernel.world.get(id)!;
    const fields = record.components.get(SCREEN)!;
    const entry = ensure(kernel, record, fields);
    const hit = surface.hit(`screen:${id}`, x, y);
    if (hit === null) return false;
    options.host.panel(kernel, entry.panel).perform(entry.instance, hit.action, hit.data, seat);
    return true;
  };

  const frame = (kernel: Kernel): void => {
    const pointer = options.host.press(kernel);
    if (pointer !== null) {
      const hit = pick(pointer.origin, pointer.direction);
      if (hit !== undefined && press(kernel, hit.entity, hit.x, hit.y, pointer.seat)) pointer.consume();
    }
    const now = kernel.time.now;
    const out = [];
    for (const [id, found] of kernel.world.query([SCREEN])) {
      const fields = found!;
      const record = kernel.world.get(id)!;
      if (fields['on'] !== true) continue;
      const entry = ensure(kernel, record, fields);
      const host = options.host.panel(kernel, entry.panel);
      const state = host.state(entry.instance);
      const key = stable(state);
      const period = 1 / (fields['fps'] as number);
      // First frame, then whenever the state changed — at most `fps` times a second.
      const due = entry.drawnAt === -Infinity || (key !== entry.drawn && now - entry.drawnAt + 1e-9 >= period);
      if (due) {
        entry.drawnAt = now;
        entry.drawn = key;
      }
      const [width, height] = texels(fields, `${name(record)} screen`);
      out.push({ target: `screen:${id}`, width, height, panel: { id: host.id, html: host.html, state, enabled: host.enabled() }, due });
    }
    for (const id of [...live.keys()]) if (!kernel.world.isAlive(id) || !kernel.world.get(id)!.components.has(SCREEN)) live.delete(id);
    if (surface === undefined) return;
    const locale = options.host.locale(kernel);
    surface.present({ time: kernel.time.realNow, screens: out, language: locale.language, strings: locale.strings, values: options.host.values(kernel) });
  };

  const material = (id: EntityId, fields: Fields): Material3d => {
    const b = fields['brightness'] as number;
    const key = `screen:${id}|${b}|${fields['double_sided'] === true}`;
    let m = materials.get(key);
    if (m === undefined) {
      m = {
        id: key, baseColor: [b, b, b, 1],
        baseColorTexture: { id: `screen:${id}`, source: { kind: 'target', target: `screen:${id}` }, colorSpace: 'srgb', wrapU: 'clamp', wrapV: 'clamp', filter: 'linear' },
        metallic: 0, roughness: 1, metallicRoughnessTexture: null, emissive: [0, 0, 0], emissiveTexture: null,
        alphaMode: 'opaque', alphaCutoff: 0.5, doubleSided: fields['double_sided'] === true, unlit: true,
      };
      materials.set(key, m);
    }
    return m;
  };

  const draws = (): MeshBatch[] => {
    const kernel = kernelOf();
    const out: MeshBatch[] = [];
    for (const [id, found] of kernel.world.query([SCREEN])) {
      const fields = found!;
      const record = kernel.world.get(id)!;
      if (fields['on'] !== true || !record.visible) continue;
      const tr = record.transform;
      const q = tr.worldRotation();
      const s = tr.worldScale();
      const p = tr.worldPosition();
      const size = fields['size'] as Vec2;
      const x = q.rotate(new Vec3(s.x * size.x, 0, 0));
      const y = q.rotate(new Vec3(0, s.y * size.y, 0));
      const z = q.rotate(new Vec3(0, 0, s.z));
      out.push({
        geometry: QUAD, material: material(id, fields), count: 1,
        instances: new Float32Array([x.x, x.y, x.z, 0, y.x, y.y, y.z, 0, z.x, z.y, z.z, 0, p.x, p.y, p.z, 1, 1, 1, 1, 1]),
        entities: [id], castShadows: false,
      });
    }
    return out;
  };

  const screenMethods = {
    /** click(action, **data): run one of the panel's actions as if its button were pressed. */
    click(this: Fields, action: unknown, ...rest: unknown[]): void {
      const kernel = kernelOf();
      if (typeof action !== 'string') fail('PP3004', `Screen.click() action must be a str, got ${String(action)}`);
      const last = rest[rest.length - 1] as { values?: Record<string, unknown> } | undefined;
      const data = last !== undefined && typeof last === 'object' && last !== null && 'values' in last ? last.values! : {};
      const record = kernel.world.get(componentEntity(this))!;
      const entry = ensure(kernel, record, this);
      options.host.panel(kernel, entry.panel).perform(entry.instance, action, data, 0);
    },
    /** press(uv): press the screen at uv (0..1 across, 0..1 down), as a pointer would. Returns whether it hit an action. */
    press(this: Fields, uv: unknown): boolean {
      const kernel = kernelOf();
      if (!(uv instanceof Vec2)) fail('PP3004', `Screen.press() takes a Vec2 uv, got ${String(uv)}`);
      const [w, h] = texels(this, 'Screen.press()');
      return press(kernel, componentEntity(this), Math.min(w - 1, Math.floor(uv.x * w)), Math.min(h - 1, Math.floor(uv.y * h)), 0);
    },
  };

  const components: ComponentDef[] = [{ id: SCREEN, schema: SCREEN_SCHEMA, methods: screenMethods }];

  return {
    id: 'screens',
    components,
    pick,
    connect(next) {
      surface = next;
    },
    install(kernel) {
      if (installed !== undefined) fail('PP3247', 'This screens plugin is already installed in another kernel', { fix: 'Call screens() once per game.' });
      installed = kernel;
      kernel.provide(SCREENS_SERVICE, { draws });
      kernel.addHook('ui', () => frame(kernel));
      kernel.observeScenes({ loading: () => live.clear() });
    },
  };
}
