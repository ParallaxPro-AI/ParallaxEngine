/**
 * The `screens` service: in-world UI screens (monitors, terminals, arcade cabinets,
 * billboards) as render3d draws them, provided by the screens plugin. Each `Screen`
 * entity shows one `@ui` panel, rendered by the platform's screen surface (core
 * `ScreenSurface`) into a texture named `screen:<entity>`; this service hands render3d the
 * quad that shows it: a `size` rectangle in the entity's local x/y plane facing +z, unlit,
 * its base color texture a `TextureSource` of kind `'target'` naming that texture.
 *
 * Who fills the target: in the browser the screen surface rasterizes the panel into a
 * canvas registered under the same name (platform/browser/screens.ts `SCREEN_TARGETS`);
 * the render3d surface uploads it when its version changes. Headless, nothing does — the
 * recorder keeps the frames, and the quad samples black (the port's rule for a target not
 * drawn yet).
 */

import type { MeshBatch } from '../../core/index.js';
import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';

export interface ScreensService {
  /** This frame's screen quads (one batch per screen that is on). */
  draws(): readonly MeshBatch[];
}

export const SCREENS_SERVICE: ServiceKey<ScreensService> = serviceKey<ScreensService>(
  'screens', 'Add screens() to Game(plugins=[...]): it shows panels on Screen entities.',
);
