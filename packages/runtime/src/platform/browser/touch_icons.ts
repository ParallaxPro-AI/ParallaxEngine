/**
 * Touch-control glyphs: stroke-based monochrome icons (24×24 viewBox, currentColor) drawn on
 * the on-screen buttons, ported from the previous engine's control overlay with its alias
 * table and its label heuristic. Pure: `touchGlyph` returns markup or text, no DOM.
 *
 * A button's `icon` is a glyph name ("target", "chevrons_up" and "chevronsUp" alike), an
 * alias ("fire" → flame), an emoji, or "auto": picked from the label ("Reload" → rotate).
 * An unknown name falls back to the label heuristic, then to the label alone.
 */

/** Path-only SVG bodies, wrapped by `iconSvg`. */
export const ICON_PATHS: Readonly<Record<string, string>> = {
  target:       '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
  eye:          '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  chevronsUp:   '<polyline points="17 11 12 6 7 11"/><polyline points="17 18 12 13 7 18"/>',
  chevronsDown: '<polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/>',
  zap:          '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  rotateCw:     '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  refresh:      '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  plus:         '<line x1="12" x2="12" y1="5" y2="19"/><line x1="5" x2="19" y1="12" y2="12"/>',
  minus:        '<line x1="5" x2="19" y1="12" y2="12"/>',
  sparkles:     '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/>',
  map:          '<polygon points="3 6 9 4 15 6 21 4 21 18 15 20 9 18 3 20 3 6"/><line x1="9" x2="9" y1="4" y2="18"/><line x1="15" x2="15" y1="6" y2="20"/>',
  box:          '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" x2="12" y1="22.08" y2="12"/>',
  arrowDown:    '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>',
  arrowUp:      '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
  hand:         '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  pause:        '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
  square:       '<rect x="4" y="4" width="16" height="16" rx="2"/>',
  shield:       '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  crosshair:    '<circle cx="12" cy="12" r="10"/><line x1="22" x2="18" y1="12" y2="12"/><line x1="6" x2="2" y1="12" y2="12"/><line x1="12" x2="12" y1="6" y2="2"/><line x1="12" x2="12" y1="22" y2="18"/>',
  exit:         '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  arrowLeft:    '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  arrowRight:   '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  bomb:         '<circle cx="11" cy="15" r="6.5"/><path d="M15.6 10.4 18 8"/><path d="M18 8a2 2 0 0 1 2.83 0L22 9"/><line x1="19" y1="4" x2="19" y2="6"/><line x1="16" y1="5" x2="17.2" y2="6.2"/>',
  droplet:      '<path d="M12 2.7 6.9 8.4a7 7 0 1 0 10.2 0Z"/>',
  flame:        '<path d="M12 2c1.6 3.2.6 5-1 6.5-1.7 1.6-3 3.2-3 5.7a6 6 0 0 0 12 0c0-3.4-2-5.2-3.6-7.2"/><path d="M12 22a3 3 0 0 1-3-3c0-1.6 1.2-2.5 2-3.6.5-.7.8-1.5.8-2.4 1.4 1 2.2 2.2 2.6 3.3.3.9.6 1.8.6 2.7a3 3 0 0 1-3 3z"/>',
  heart:        '<path d="M20.8 6.6a5 5 0 0 0-7.1 0L12 8.3l-1.7-1.7a5 5 0 0 0-7.1 7.1L12 22l8.8-8.3a5 5 0 0 0 0-7.1z"/>',
  search:       '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16" y2="16"/>',
  star:         '<polygon points="12 2.5 15 9 22 9.8 16.8 14.4 18.4 21.5 12 17.9 5.6 21.5 7.2 14.4 2 9.8 9 9"/>',
  sword:        '<path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><line x1="13" y1="19" x2="19" y2="13"/><line x1="16" y1="16" x2="20" y2="20"/>',
  undo:         '<polyline points="9 14 4 9 9 4"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  wind:         '<path d="M3 8h10a3 3 0 1 0-3-3"/><path d="M3 12h14a3 3 0 1 1-3 3"/><path d="M3 16h7"/>',
  wrench:       '<path d="M14.7 6.3a4 4 0 0 0 5 5l-8.4 8.4a2.8 2.8 0 0 1-4-4Z"/><path d="M14.7 6.3 18 3a4 4 0 0 0-3.3 3.3z"/>',
  horn:         '<path d="M3 10v4h3l6 4V6l-6 4H3z"/><path d="M16.5 9a4 4 0 0 1 0 6"/><path d="M19 6.5a7.5 7.5 0 0 1 0 11"/>',
  home:         '<path d="M3 11 12 3l9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  bag:          '<path d="M6 7h12l1 14H5L6 7z"/><path d="M9 7a3 3 0 0 1 6 0"/>',
  plane:        '<path d="M2 13l20-8-8 20-2-9-10-3z"/>',
  camera:       '<path d="M4 7h4l2-3h4l2 3h4v13H4z"/><circle cx="12" cy="13" r="4"/>',
  phone:        '<rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/>',
  x:            '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
  redo:         '<polyline points="15 14 20 9 15 4"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  anchor:       '<circle cx="12" cy="5" r="2"/><line x1="12" y1="7" x2="12" y2="21"/><path d="M5 13a7 7 0 0 0 14 0"/><line x1="8" y1="10" x2="16" y2="10"/>',
  door:         '<path d="M6 21V3h12v18"/><line x1="3" y1="21" x2="21" y2="21"/><circle cx="15" cy="12" r="1" fill="currentColor"/>',
  clipboard:    '<rect x="5" y="4" width="14" height="17" rx="2"/><rect x="9" y="2" width="6" height="4" rx="1"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="15" y2="15"/>',
  steer:        '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/><line x1="3" y1="12" x2="10" y2="12"/><line x1="14" y1="12" x2="21" y2="12"/><line x1="12" y1="14" x2="12" y2="21"/>',
};

/** Other spellings that have an obvious glyph. */
export const ICON_ALIASES: Readonly<Record<string, string>> = {
  fist: 'target', punch: 'target', kick: 'target', melee: 'sword', blade: 'sword', knife: 'sword',
  fire: 'flame', burn: 'flame', explosion: 'bomb', grenade: 'bomb', health: 'heart', life: 'heart',
  water: 'droplet', potion: 'droplet', repair: 'wrench', tool: 'wrench', build: 'wrench', hammer: 'wrench',
  scan: 'search', inspect: 'search', magnify: 'search', zoom: 'search', reset: 'undo', restart: 'undo',
  revert: 'undo', back: 'undo', circle: 'target', ring: 'target', dot: 'target', cornerLeftUp: 'arrowLeft',
  cornerRightUp: 'arrowRight', left: 'arrowLeft', right: 'arrowRight', up: 'arrowUp', down: 'arrowDown',
  arrow: 'arrowUp', bell: 'sparkles', cloud: 'wind', dice5: 'square', volume: 'horn', volume2: 'horn',
  speaker: 'horn', honk: 'horn', siren: 'horn', spark: 'zap', burst: 'zap', lightning: 'zap', boost: 'zap',
  dash: 'wind', package: 'box', crate: 'box', inventory: 'box', cannonLeft: 'arrowLeft', cannonRight: 'arrowRight',
  cannon: 'target', flaps: 'chevronsDown', brake: 'square', stop: 'square', flower: 'star', close: 'x',
  cancel: 'x', house: 'home', shop: 'bag', store: 'bag', cart: 'bag', photo: 'camera', call: 'phone',
  wheel: 'steer', exitDoor: 'door', jump: 'chevronsUp', crouch: 'chevronsDown', reload: 'rotateCw',
};

/** A glyph name for a label, or undefined: the label's words are the strongest signal of intent. */
export function iconForLabel(label: string): string | undefined {
  const l = label.toLowerCase().trim();
  if (l === '') return undefined;
  const rules: readonly (readonly [RegExp, string])[] = [
    [/\b(fire|shoot|attack|hit|cannon|tap)\b/, 'target'],
    [/\b(aim|look|scope)\b/, 'eye'],
    [/\b(jump|hop|leap|bounce)\b/, 'chevronsUp'],
    [/\b(crouch|duck)\b/, 'chevronsDown'],
    [/\b(sprint|run|dash|drift|boost|nitro)\b/, 'zap'],
    [/\b(brake)\b/, 'square'],
    [/\b(reload)\b/, 'rotateCw'],
    [/\b(switch|cycle|next|change|swap|rotate)\b/, 'refresh'],
    [/\b(use|grab|interact|enter|pick|kick|action|press)\b/, 'hand'],
    [/\b(drop|throw|toss)\b/, 'arrowDown'],
    [/\b(repair|fix|wrench|tool|mend)\b/, 'wrench'],
    [/\b(bomb|explode|grenade|blast|detonate)\b/, 'bomb'],
    [/\b(burn|flame|ignite|torch|light)\b/, 'flame'],
    [/\b(scan|search|inspect|examine|find)\b/, 'search'],
    [/\b(undo|reset|restart|revert|respawn)\b/, 'undo'],
    [/\b(health|life|revive)\b/, 'heart'],
    [/\b(water|drink|thirst|potion|fuel)\b/, 'droplet'],
    [/\b(slash|sword|blade|melee|stab)\b/, 'sword'],
    [/\b(heal|add)\b/, 'plus'],
    [/\b(exit|leave|out)\b/, 'exit'],
    [/\b(map)\b/, 'map'],
    [/\b(item|powerup|skill|ability|special|magic|spell)\b/, 'sparkles'],
    [/\b(inventory|menu|wave|scoreboard|score)\b/, 'box'],
    [/\b(reduce|remove)\b/, 'minus'],
    [/\b(pause)\b/, 'pause'],
    [/\b(select)\b/, 'crosshair'],
    [/\b(block|defend|guard|shield)\b/, 'shield'],
    [/\b(plant|place|put)\b/, 'plus'],
    [/\b(mine|dig)\b/, 'target'],
    [/\b(horn|honk)\b/, 'horn'],
    [/\b(shop|store|buy)\b/, 'bag'],
    [/\b(home|recall)\b/, 'home'],
  ];
  return rules.find(([re]) => re.test(l))?.[1];
}

/** "chevrons_up" → "chevronsUp". */
function camel(name: string): string {
  return name.replace(/[_-]+([a-z0-9])/gi, (_, c: string) => c.toUpperCase());
}

/** The glyph a name means: itself, its camelCase spelling, or an alias. */
export function glyphName(name: string): string | undefined {
  for (const n of [name, camel(name)]) {
    if (ICON_PATHS[n] !== undefined) return n;
    const alias = ICON_ALIASES[n] ?? ICON_ALIASES[n.toLowerCase()];
    if (alias !== undefined) return alias;
  }
  return undefined;
}

export function iconSvg(name: string, size: number): string {
  const body = ICON_PATHS[name];
  if (body === undefined) return '';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="${size}" height="${size}" aria-hidden="true">${body}</svg>`;
}

export type TouchGlyph = { readonly kind: 'svg'; readonly html: string } | { readonly kind: 'text'; readonly text: string } | { readonly kind: 'none' };

/** What a button shows besides its label: `icon` resolved as the module comment says. */
export function touchGlyph(icon: string | undefined, label: string, size: number): TouchGlyph {
  if (icon === undefined || icon === '') return { kind: 'none' };
  // An emoji (or any short non-ASCII text) is drawn as is.
  if (icon !== 'auto' && /[^\x00-\x7f]/.test(icon) && [...icon].length <= 4) return { kind: 'text', text: icon };
  const name = (icon === 'auto' ? undefined : glyphName(icon)) ?? iconForLabel(label);
  return name !== undefined && ICON_PATHS[name] !== undefined ? { kind: 'svg', html: iconSvg(name, size) } : { kind: 'none' };
}
