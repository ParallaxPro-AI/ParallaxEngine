/**
 * The ids of the engine's own `@ui` panels: declared by every game (api/ui.ts, interaction.ts,
 * cinematics.ts and the HUD kit in hud.ts), so a game panel may not take one (PP4420).
 * `parallax check` reads this list; api/ui.test.ts keeps it equal to what the api registers.
 */
export const BUILTIN_PANEL_IDS: readonly string[] = [
  'settings', 'dialogue', 'interact_prompt', 'cinematic',
  'hud_screen', 'hud_nameplates', 'hud_awareness', 'hud_markers', 'hud_crosshair', 'hud_minimap', 'hud_compass',
  'hud_stat_bars', 'hud_ability_bar', 'hud_combo', 'hud_key_hints',
];
