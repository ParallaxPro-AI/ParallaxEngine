/**
 * `<icon name="coin">` in panel markup: one of the engine's built-in icons (core's
 * `UI_ICONS`), expanded once the markup is sanitized (the glyphs are engine data; the
 * element's own attributes went through the sanitizer) into an inline 24×24 `<svg
 * class="parallax-icon">` sized 1em and filled with the text color. Other attributes stay on
 * the svg (`class`, `style`, `data-*` bindings); `label="Gold"` makes it an image with that
 * accessible name, otherwise it is hidden from assistive technology (decoration next to text).
 */

import { UI_ICONS } from '../../../core/index.js';
import { parseMarkup } from './markup.js';
import type { MarkupElement, MarkupNode } from './markup.js';

/** The svg element an icon expands to, or undefined for an unknown name. */
export function iconElement(name: string, attrs: readonly (readonly [string, string])[] = []): MarkupElement | undefined {
  const glyph = UI_ICONS[name];
  if (glyph === undefined) return undefined;
  const label = attrs.find(([n]) => n === 'label')?.[1];
  const own = attrs.filter(([n]) => n !== 'name' && n !== 'label' && n !== 'class' && n !== 'viewbox');
  const classes = ['parallax-icon', ...(attrs.find(([n]) => n === 'class')?.[1].split(/\s+/).filter((c) => c !== '') ?? [])];
  return {
    kind: 'element',
    tag: 'svg',
    attrs: [
      ['class', classes.join(' ')], ['viewBox', '0 0 24 24'], ['data-icon', name],
      ...(label === undefined ? [['aria-hidden', 'true'] as const] : [['role', 'img'] as const, ['aria-label', label] as const]),
      ...own,
    ],
    children: parseMarkup(glyph),
  };
}

/** Markup with every `<icon>` expanded; `unknown` hears each name that isn't a built-in icon (its element is dropped). */
export function expandIcons(nodes: readonly MarkupNode[], unknown: (name: string) => void): MarkupNode[] {
  const out: MarkupNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'text') {
      out.push(node);
      continue;
    }
    if (node.tag !== 'icon') {
      out.push({ ...node, children: expandIcons(node.children, unknown) });
      continue;
    }
    const name = node.attrs.find(([n]) => n === 'name')?.[1].trim() ?? '';
    const svg = iconElement(name, node.attrs);
    if (svg === undefined) unknown(name);
    else out.push(svg);
  }
  return out;
}
