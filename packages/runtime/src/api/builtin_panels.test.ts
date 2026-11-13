/** core's BUILTIN_PANEL_IDS (read by `parallax check`, PP4420) is every panel the api registers as built-in. */

import { describe, expect, it } from 'vitest';
import { BUILTIN_PANEL_IDS } from '../core/index.js';
// The api and the plugins module: every module that declares a built-in panel.
import './index.js';
import './plugins.js';
import { builtinPanelIds } from './ui.js';

describe('built-in panel ids', () => {
  it('core lists exactly the panels the engine declares', () => {
    expect([...builtinPanelIds()].sort()).toEqual([...BUILTIN_PANEL_IDS].sort());
  });
});
