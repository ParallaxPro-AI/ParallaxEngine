/**
 * The 2D render port: what the engine hands a drawing surface each frame, and what it
 * asks of it. The render2d plugin builds one immutable `Frame2d` per frame — a camera
 * view plus a back-to-front list of primitives in world space — and the platform draws it:
 * Canvas2D in the browser (`platform/browser/render.ts`), a recorder in headless tests
 * (`platform/headless/render.ts`), a WebGL batcher later (commands carry everything a
 * batcher keys on: kind, image, z order).
 *
 * Units are world meters with +y up. Colors are straight-alpha RGBA in 0..1. Images are
 * project paths (`assets/images/ship.png`); the surface maps them to whatever it loads.
 */

import type { Diagnostic } from '../diagnostics.js';

/** Straight-alpha color, each channel 0..1. */
export type Rgba = readonly [r: number, g: number, b: number, a: number];

/**
 * A 2D affine transform from a command's local space to world space, in Canvas2D's
 * `setTransform(a, b, c, d, e, f)` layout: x' = a·x + c·y + e, y' = b·x + d·y + f.
 */
export type Affine2d = readonly [a: number, b: number, c: number, d: number, e: number, f: number];

/** What the camera sees. The surface maps it onto its pixels (y flipped: world +y is up). */
export interface View2d {
  /** World point at the middle of the viewport. */
  readonly center: readonly [x: number, y: number];
  /** Meters visible from the center to the top edge; the width follows the viewport's aspect. */
  readonly halfHeight: number;
  /** Camera roll in degrees, counter-clockwise (the world appears turned the other way). */
  readonly angle: number;
  /** Clear color; null = transparent (whatever is behind the surface shows). */
  readonly background: Rgba | null;
  /** Fractions of the surface: x, y from the top-left, width, height. Full surface = [0, 0, 1, 1]. */
  readonly viewport: readonly [x: number, y: number, width: number, height: number];
}

interface Placed {
  /** Draw-order key the list is sorted by (transform z: higher on top). Kept for inspection. */
  readonly z: number;
  /** The entity it belongs to; null for effects that outlive any entity (one-shot vfx, beams). */
  readonly entity: number | null;
}

/** An image (a sprite, or a textured rect) centered on the local origin. */
export interface ImageDraw extends Placed {
  readonly kind: 'image';
  readonly transform: Affine2d;
  readonly image: string;
  /** Full width and height in local meters. */
  readonly size: readonly [w: number, h: number];
  /** Multiplied into the image's pixels; [1, 1, 1, 1] draws it unchanged. */
  readonly tint: Rgba;
  readonly flipX: boolean;
  readonly flipY: boolean;
  /** "additive": its colors add to what is under it (a sprite's `blend`). Absent: "normal" (painted over). */
  readonly blend?: 'normal' | 'additive';
}

/** An outline centered on a shape's edge. */
export interface Stroke2d {
  /** Local meters. */
  readonly width: number;
  readonly color: Rgba;
}

/** A filled rectangle centered on the local origin. */
export interface RectDraw extends Placed {
  readonly kind: 'rect';
  readonly transform: Affine2d;
  readonly size: readonly [w: number, h: number];
  readonly fill: Rgba;
  /** Rounded-corner radius in local meters (absent: square corners). */
  readonly radius?: number;
  readonly stroke?: Stroke2d;
  /** "additive": its colors add to what is under it (an imageless sprite's `blend`). Absent: "normal". */
  readonly blend?: 'normal' | 'additive';
}

/** A filled ellipse inscribed in `size`, centered on the local origin; optionally textured. */
export interface EllipseDraw extends Placed {
  readonly kind: 'ellipse';
  readonly transform: Affine2d;
  readonly size: readonly [w: number, h: number];
  readonly fill: Rgba;
  /** Drawn clipped to the ellipse and multiplied by `fill`. */
  readonly image: string | null;
  /** A ring: the unfilled inner ellipse's full width and height (absent: solid). */
  readonly hole?: readonly [w: number, h: number];
  readonly stroke?: Stroke2d;
}

/** A filled closed polygon in local meters. */
export interface PolygonDraw extends Placed {
  readonly kind: 'polygon';
  readonly transform: Affine2d;
  /** x, y pairs, at least three corners. */
  readonly points: readonly number[];
  readonly fill: Rgba;
  readonly stroke?: Stroke2d;
}

/** A run of text with one style. */
export interface TextSpan {
  readonly text: string;
  readonly color: Rgba;
  readonly bold: boolean;
}

/** Text centered on the local origin; spans may contain "\n" line breaks. */
export interface TextDraw extends Placed {
  readonly kind: 'text';
  readonly transform: Affine2d;
  /** Line height in local meters. */
  readonly size: number;
  readonly spans: readonly TextSpan[];
}

/** A batch of particles from one emitter, already in world space. */
export interface ParticlesDraw extends Placed {
  readonly kind: 'particles';
  readonly shape: 'circle' | 'square';
  /** Drawn instead of `shape` when set, tinted by each particle's color. */
  readonly image: string | null;
  /** "additive": colors add (glows where particles overlap). Absent: "normal" (painted over). */
  readonly blend?: 'normal' | 'additive';
  /** Number of particles in `data`. */
  readonly count: number;
  /** `PARTICLE_STRIDE` numbers per particle: x, y, size (diameter, m), angle (deg), r, g, b, a. */
  readonly data: readonly number[];
}

export const PARTICLE_STRIDE = 8;

/** A polyline in world space (beams, trails, debug lines). */
export interface LineDraw extends Placed {
  readonly kind: 'line';
  /** x, y pairs. */
  readonly points: readonly number[];
  /** Meters. */
  readonly width: number;
  readonly color: Rgba;
}

export type Draw2d = ImageDraw | RectDraw | EllipseDraw | PolygonDraw | TextDraw | ParticlesDraw | LineDraw;

/** A 2D light (a `Light` component on a 2D entity). */
export interface Light2d {
  readonly kind: 'point' | 'spot';
  /** World position. */
  readonly x: number;
  readonly y: number;
  /** Straight color, 0..1. */
  readonly color: readonly [r: number, g: number, b: number];
  readonly intensity: number;
  /** Meters; light falls to zero here ((1 - d / radius)² falloff). */
  readonly radius: number;
  /** Spot: the cone's center, degrees counter-clockwise from +x, and its full angle. */
  readonly direction: number;
  readonly cone: number;
  /** Spot: full angle of the fully lit core (≤ cone); the light fades from it to the cone's edge. Absent: a hard edge. */
  readonly inner?: number;
  readonly entity: number;
}

/**
 * 2D lighting: the drawn scene is multiplied by a light map — `ambient` everywhere, plus
 * each light added with its falloff. Present when the scene has at least one Light.
 */
export interface Lighting2d {
  readonly ambient: readonly [r: number, g: number, b: number];
  readonly lights: readonly Light2d[];
}

/** Gradient stops (offset along the radius, strength) of a 2D light's `(1 - d / radius)²` falloff. */
export const LIGHT_FALLOFF_STOPS: readonly (readonly [offset: number, strength: number])[] =
  [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1].map((t) => [t, (1 - t) * (1 - t)] as const);

/**
 * Fog of war over a 2D world (a camera's `fog_overlay`, the ai plugin's fog grid, its
 * ground axes x and z read as the 2D world's x and y): drawn over everything, clear where
 * the team sees now, `explored` where it has seen, `unexplored` elsewhere, soft-edged.
 */
export interface Fog2d {
  /** Differs whenever the cells or the rectangle do. */
  readonly key: string;
  readonly cell: number;
  /** World x, y of the first cell's corner. */
  readonly minX: number;
  readonly minY: number;
  readonly cols: number;
  readonly rows: number;
  /** Row-major from (minX, minY), +y rows: bit 1 visible now, bit 2 explored. */
  readonly cells: Uint8Array;
  readonly unexplored: Rgba;
  readonly explored: Rgba;
}

/** One frame. The engine never changes a frame after handing it over, so it may be kept. */
export interface Frame2d {
  /** The kernel's frame number. */
  readonly frame: number;
  readonly view: View2d;
  /** Back to front: sorted by z, ties in submission order (entities in spawn order, then effects). */
  readonly commands: readonly Draw2d[];
  /** Null: no lights, the scene is drawn as authored. */
  readonly lighting: Lighting2d | null;
  /** Fog of war over everything (absent or null: none). */
  readonly fog?: Fog2d | null;
  /** Shockwave ripples bending the finished image (absent or empty: none). */
  readonly ripples?: readonly Ripple2d[];
  /** Bloom and vignette over the finished image (absent or null: none). */
  readonly post?: Post2d | null;
}

/**
 * 2D post-processing (the environment's `post` keys a canvas can draw). Brightness is the
 * drawn color, 0..1: what is brighter than `bloomThreshold` glows by `bloom` (so a
 * threshold of 1 or more never glows), and `vignette` darkens toward the corners.
 */
export interface Post2d {
  readonly bloom: number;
  readonly bloomThreshold: number;
  readonly vignette: number;
}

/** A shockwave ring in world meters: the image within `width` of the ring's edge bends outward. */
export interface Ripple2d {
  readonly x: number;
  readonly y: number;
  /** The ring's radius now (meters). */
  readonly radius: number;
  /** The band's full width (meters). */
  readonly width: number;
  /** 0..1: how far the image bends (at 1, about a quarter of the band's width). */
  readonly strength: number;
}

/** A surface that draws 2D frames. Implemented in `platform/`. */
export interface RenderSurface2d {
  /** Drawing area in pixels; its aspect decides how much the camera shows. */
  size(): { readonly width: number; readonly height: number };
  /** Begin loading an image so it is ready when drawn. Repeated calls for one path are no-ops. */
  load(image: string): void;
  draw(frame: Frame2d): void;
  /** Load failures found since the last call (a 404, an undecodable file), as diagnostics. */
  takeProblems(): readonly Diagnostic[];
}
