/**
 * TextMesh markup (sdk TextMesh): `[color=#888]…[/color]` and `[b]…[/b]` spans, nestable.
 * Any other `[` is literal text. A closing tag with nothing open, or a tag left open, is
 * PP3603 — markup that silently swallowed text would be invisible to the author.
 */

import { Color, fail } from '../../../core/index.js';
import type { Rgba, TextSpan } from '../../../core/index.js';

const TAG = /\[(\/?)(b|color)(?:=(#[0-9a-fA-F]{3,8}))?\]/g;

export function parseMarkup(text: string, base: Rgba): TextSpan[] {
  const spans: TextSpan[] = [];
  const colors: Rgba[] = [];
  let bold = 0;
  let at = 0;
  const push = (chunk: string): void => {
    if (chunk === '') return;
    const color = colors[colors.length - 1] ?? base;
    const last = spans[spans.length - 1];
    if (last !== undefined && last.color === color && last.bold === bold > 0) {
      spans[spans.length - 1] = { ...last, text: last.text + chunk };
    } else {
      spans.push({ text: chunk, color, bold: bold > 0 });
    }
  };
  for (const match of text.matchAll(TAG)) {
    const [whole, closing, name, value] = match;
    if (name === 'b' && value !== undefined) continue;
    if (name === 'color' && (closing === '') !== (value !== undefined)) continue;
    push(text.slice(at, match.index));
    at = match.index + whole.length;
    if (name === 'b') {
      if (closing === '') bold++;
      else if (bold === 0) fail('PP3603', `Text "${text}" closes [/b] without an open [b]`, { fix: 'Remove the [/b] or add [b] before it.' });
      else bold--;
    } else if (closing === '') {
      const c = Color.hex(value!);
      colors.push([c.r, c.g, c.b, c.a * base[3]]);
    } else if (colors.length === 0) {
      fail('PP3603', `Text "${text}" closes [/color] without an open [color=…]`, { fix: 'Remove the [/color] or add [color=#rrggbb] before it.' });
    } else {
      colors.pop();
    }
  }
  push(text.slice(at));
  if (bold > 0 || colors.length > 0) {
    fail('PP3603', `Text "${text}" leaves ${bold > 0 ? '[b]' : '[color=…]'} open`, { fix: `Close it with ${bold > 0 ? '[/b]' : '[/color]'}.` });
  }
  return spans;
}
