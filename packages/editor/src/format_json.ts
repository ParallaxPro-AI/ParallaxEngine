/**
 * JSON laid out the way the file already was, so an edit's diff stays on the lines it changed:
 *
 *   compact   hand-written data: a value stays on one line when it fits (`"at": [0, 1.5, 4]`,
 *             `{ "prefab": "rail", "at": [9.4, 0.3, 0.2] }`), otherwise one entry per line — and
 *             a list of several objects (placements, children) always one per line;
 *             braces padded or not (`{"a": 1}`) and the line width as the file has them
 *   expanded  generated data (`json.dumps(indent=1)`, `JSON.stringify(v, null, 2)`): every
 *             container broken, one value per line
 *
 * `jsonStyle` reads the layout from the file's current text; a new file is compact with two
 * spaces and padded braces. The top level always breaks. Number spelling isn't kept (`2.0`
 * is written `2`): the text is made from parsed values.
 */

import type { Json } from '@parallax/runtime/resource';

export interface JsonStyle {
  readonly indent: string;
  readonly compact: boolean;
  /** `{ "a": 1 }` rather than `{"a": 1}`. */
  readonly padBraces: boolean;
  /** Compact: the longest line a value may stay inline on. */
  readonly width: number;
}

export const DEFAULT_STYLE: JsonStyle = { indent: '  ', compact: true, padBraces: true, width: 110 };

/** The layout a file's text uses. */
export function jsonStyle(text: string | undefined): JsonStyle {
  if (text === undefined) return DEFAULT_STYLE;
  const lines = text.split('\n');
  const indented = lines.find((l) => /^[ \t]+\S/.test(l));
  const indent = indented === undefined ? DEFAULT_STYLE.indent : /^[ \t]+/.exec(indented)![0];
  // Compact: some value opens a non-empty container and keeps content on its line (`[0, 1]`, `{ "a": 1 }`).
  const compact = lines.some((l) => /^[[{]\s*[^\s\]}]/.test(l.trim().replace(/^"(?:[^"\\]|\\.)*":\s*/, '')));
  const tight = lines.filter((l) => /\{"/.test(l)).length;
  const padded = lines.filter((l) => /\{ "/.test(l)).length;
  const longest = lines.reduce((n, l) => Math.max(n, l.length), 0);
  return {
    indent, compact: lines.length <= 2 || compact, padBraces: padded >= tight,
    width: Math.min(240, Math.max(DEFAULT_STYLE.width, longest)),
  };
}

function inline(value: Json, pad: string): string {
  if (Array.isArray(value)) return value.length === 0 ? '[]' : `[${value.map((v) => inline(v, pad)).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    return entries.length === 0 ? '{}' : `{${pad}${entries.map(([k, v]) => `${JSON.stringify(k)}: ${inline(v, pad)}`).join(', ')}${pad}}`;
  }
  return JSON.stringify(value);
}

function print(value: Json, style: JsonStyle, indent: string, prefix: number, top: boolean): string {
  const container = value !== null && typeof value === 'object';
  if (!container) return JSON.stringify(value);
  const empty = Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;
  if (empty) return Array.isArray(value) ? '[]' : '{}';
  const records = Array.isArray(value) && value.length > 1 && value.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v));
  if (style.compact && !top && !records) {
    const flat = inline(value, style.padBraces ? ' ' : '');
    // +1: the comma that may follow.
    if (indent.length + prefix + flat.length + 1 <= style.width) return flat;
  }
  const inner = indent + style.indent;
  if (Array.isArray(value)) {
    return `[\n${value.map((v) => `${inner}${print(v, style, inner, 0, false)}`).join(',\n')}\n${indent}]`;
  }
  return `{\n${Object.entries(value).map(([k, v]) => {
    const key = `${JSON.stringify(k)}: `;
    return `${inner}${key}${print(v, style, inner, key.length, false)}`;
  }).join(',\n')}\n${indent}}`;
}

export function formatJson(value: Json, style: JsonStyle = DEFAULT_STYLE): string {
  return `${print(value, style, '', 0, true)}\n`;
}
