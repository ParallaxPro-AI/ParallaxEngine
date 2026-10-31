/** Forgetting a game's declarations (a fresh module realm; tests). */

import { resetGameDeclarations } from './declarations.js';
import { resetActionSets } from './input.js';
import { resetPanels } from './ui.js';
import { resetMigrations } from './save.js';
import { resetStory } from './story.js';
import { resetRpcs } from './net.js';

/** Forget every declaration the game made: data, logic, action sets, panels, save migrations, story facts/verbs/commands and RPCs. */
export function resetDeclarations(): void {
  resetGameDeclarations();
  resetActionSets();
  resetPanels();
  resetMigrations();
  resetStory();
  resetRpcs();
}
