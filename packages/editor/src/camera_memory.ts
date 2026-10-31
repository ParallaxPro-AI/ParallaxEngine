/**
 * The editor camera remembered per project and scene, in localStorage: a reload (or coming
 * back to a scene) opens the view where it was left. Only a scene never viewed before
 * starts from the game's camera (the session's default). Best effort: no storage, or a
 * stored value that doesn't read, is the same as nothing stored.
 */

import { Quat, Vec3 } from '@parallax/runtime/core';
import type { CameraPose } from './session/index.js';

/** What is kept: position, rotation (x, y, z, w), and the lens. */
export interface StoredPose {
  readonly p: readonly [number, number, number];
  readonly r: readonly [number, number, number, number];
  readonly fov?: number;
  readonly size?: number;
}

export type PoseStorage = Pick<Storage, 'getItem' | 'setItem'>;

const PREFIX = 'parallax-editor:camera:';

/** The project's key: the `?project=` name the server serves (when there is one) and the game's id. */
export function projectKey(gameId: string, search = ''): string {
  const name = new URLSearchParams(search).get('project')?.trim();
  return name === undefined || name === '' ? gameId : `${name}:${gameId}`;
}

export function cameraKey(project: string, scene: string): string {
  return `${PREFIX}${project}:${scene}`;
}

const round = (n: number): number => Math.round(n * 1e5) / 1e5;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function encodePose(pose: CameraPose): StoredPose {
  const { position: p, rotation: r } = pose;
  return {
    p: [round(p.x), round(p.y), round(p.z)],
    r: [round(r.x), round(r.y), round(r.z), round(r.w)],
    ...(finite(pose.fov) && { fov: round(pose.fov) }),
    ...(finite(pose.size) && { size: round(pose.size) }),
  };
}

/** A stored pose back, or undefined when it isn't one (wrong shape, non-finite, zero rotation). */
export function decodePose(value: unknown): CameraPose | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { p, r, fov, size } = value as Record<string, unknown>;
  if (!Array.isArray(p) || p.length !== 3 || !p.every(finite)) return undefined;
  if (!Array.isArray(r) || r.length !== 4 || !r.every(finite)) return undefined;
  const [x, y, z, w] = r as number[];
  const length = Math.hypot(x!, y!, z!, w!);
  if (length < 1e-6) return undefined;
  return {
    position: new Vec3(p[0], p[1], p[2]),
    rotation: new Quat(x! / length, y! / length, z! / length, w! / length),
    ...(finite(fov) && fov > 0 && { fov }),
    ...(finite(size) && size > 0 && { size }),
  };
}

function browserStorage(): PoseStorage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

export class CameraMemory {
  readonly project: string;
  readonly #storage: PoseStorage | undefined;
  /** What was last written per key, so an unmoved camera writes nothing. */
  readonly #written = new Map<string, string>();

  constructor(project: string, storage: PoseStorage | undefined = browserStorage()) {
    this.project = project;
    this.#storage = storage;
  }

  load(scene: string): CameraPose | undefined {
    try {
      const raw = this.#storage?.getItem(cameraKey(this.project, scene));
      if (raw === null || raw === undefined) return undefined;
      this.#written.set(cameraKey(this.project, scene), raw);
      return decodePose(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  /** Keep `pose` for `scene`; answers whether anything was written. */
  save(scene: string, pose: CameraPose): boolean {
    const key = cameraKey(this.project, scene);
    const text = JSON.stringify(encodePose(pose));
    if (this.#written.get(key) === text) return false;
    try {
      this.#storage?.setItem(key, text);
    } catch {
      return false; // Full or blocked storage: not kept past this page.
    }
    this.#written.set(key, text);
    return this.#storage !== undefined;
  }
}
