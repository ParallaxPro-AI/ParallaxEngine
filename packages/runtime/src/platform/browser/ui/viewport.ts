/**
 * Panel CSS measures the GAME VIEW, not the page. A panel draws in a shadow root on the host
 * page (or a frame), so `vh` / `vw` and `@media (width ...)` would measure the whole page,
 * e.g. the editor window around a smaller game view. Every panel host is therefore a size
 * container named `parallax-view`, and panel CSS is rewritten when it is compiled:
 *
 *   12vh, 3dvw, 2svmin, 5lvmax    12cqh, 3cqw, 2cqmin, 5cqmax (`vb` / `vi`: `cqb` / `cqi`)
 *   @media (max-width: 600px)     @container parallax-view (max-width: 600px)
 *   @media screen and (...)       the media type is dropped: a panel is always on screen
 *   @media (pointer: coarse) and (max-height: 500px)
 *                                 @media (pointer: coarse) { @container parallax-view (...) { ... } }
 *   @media (a), (b)               @container parallax-view ((a)) or ((b)) when every query is a
 *                                 size query; a list that mixes in other features stays @media
 *
 * Size features are width, height, aspect-ratio and orientation (with `min-` / `max-` or the
 * range form); everything else (pointer, hover, prefers-*, print) stays a media query.
 * Strings, comments and `url()`s are left alone. In a standalone play page the game view is
 * the page, so the result is the same as before.
 *
 * Container units resolve against the nearest size container: inside an element a game
 * itself made a size container they measure that element (the panel's own CSS asked for it).
 */

export const VIEW_CONTAINER = 'parallax-view';

/** The style that makes an element the game view panels measure. */
export const VIEW_CONTAINER_STYLE = `${VIEW_CONTAINER} / size`;

const UNIT = /(^|[^\w.-])([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)[dsl]?v(h|w|min|max|b|i)(?![\w-])/gi;
const SIZE_FEATURE = /^(?:(?:min|max)-)?(?:width|height|aspect-ratio|orientation)$/i;

/** The end (exclusive) of a string, comment or `url(...)` starting at `i`, or -1 when none starts there. */
function protectedEnd(css: string, i: number): number {
  const c = css[i];
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < css.length && css[j] !== c) j += css[j] === '\\' ? 2 : 1;
    return Math.min(css.length, j + 1);
  }
  if (c === '/' && css[i + 1] === '*') {
    const end = css.indexOf('*/', i + 2);
    return end < 0 ? css.length : end + 2;
  }
  if ((c === 'u' || c === 'U') && /^url\(/i.test(css.slice(i, i + 4)) && !/[\w-]/.test(css[i - 1] ?? '')) {
    let j = i + 4;
    while (j < css.length && css[j] !== ')') {
      const q = css[j];
      j = q === '"' || q === "'" ? protectedEnd(css, j) : j + (q === '\\' ? 2 : 1);
    }
    return Math.min(css.length, j + 1);
  }
  return -1;
}

/** Viewport units as container units, outside strings, comments and urls. */
export function containerUnits(css: string): string {
  let out = '';
  let code = '';
  const flush = (): void => {
    out += code.replace(UNIT, (_w, pre: string, n: string, u: string) => `${pre}${n}cq${u.toLowerCase()}`);
    code = '';
  };
  for (let i = 0; i < css.length;) {
    const end = protectedEnd(css, i);
    if (end < 0) {
      code += css[i];
      i++;
      continue;
    }
    flush();
    out += css.slice(i, end);
    i = end;
  }
  flush();
  return out;
}

/** Split at top-level occurrences of `sep` (a regex matched at paren depth 0). */
function splitTop(text: string, sep: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0) {
      const m = sep.exec(text.slice(i));
      if (m !== null && m.index === 0) {
        parts.push(text.slice(start, i));
        i += m[0].length - 1;
        start = i + 1;
      }
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim());
}

type Group = 'size' | 'media' | 'mixed';

/** The feature names in a condition: `(max-width: 9px)`, `(400px <= width)`, `(hover)`. */
function featureNames(group: string): string[] {
  const names: string[] = [];
  for (const [, inner] of group.matchAll(/\(([^()]*)\)/g)) {
    const text = inner!.trim();
    const colon = text.indexOf(':');
    if (colon >= 0) names.push(text.slice(0, colon).trim());
    else if (/[<>=]/.test(text)) names.push(...text.split(/[<>=]+/).map((t) => t.trim()).filter((t) => /^[a-z-]+$/i.test(t)));
    else names.push(text);
  }
  return names;
}

function classify(group: string): Group {
  const names = featureNames(group);
  if (names.length === 0) return 'mixed';
  const size = names.filter((n) => SIZE_FEATURE.test(n)).length;
  return size === names.length ? 'size' : size === 0 ? 'media' : 'mixed';
}

interface Query {
  readonly size: readonly string[];
  readonly media: readonly string[];
}

/** One media query split into its size and other conditions, or undefined when it can't be. */
function query(text: string): Query | undefined {
  const parts = splitTop(text, /^\s+and\s+/i);
  const size: string[] = [];
  const media: string[] = [];
  for (const [i, part] of parts.entries()) {
    if (part.startsWith('(') && part.endsWith(')')) {
      const kind = classify(part);
      if (kind === 'mixed') return undefined;
      (kind === 'size' ? size : media).push(part);
      continue;
    }
    // A leading media type: screen / all are always true for a panel; any other stays media.
    if (i !== 0) return undefined;
    const type = part.replace(/^only\s+/i, '').toLowerCase();
    if (type === 'screen' || type === 'all') continue;
    return undefined;
  }
  return { size, media };
}

/** The new head for `@media <prelude>`, and whether the block needs one more closing brace. */
function mediaHead(prelude: string): { head: string; nested: boolean } | undefined {
  const queries = splitTop(prelude, /^,/).map(query);
  if (queries.some((q) => q === undefined)) return undefined;
  const qs = queries as Query[];
  if (qs.every((q) => q.size.length === 0)) return undefined;
  const container = (q: Query): string => q.size.join(' and ');
  if (qs.length > 1) {
    if (qs.some((q) => q.media.length > 0)) return undefined;
    return { head: `@container ${VIEW_CONTAINER} ${qs.map((q) => `(${container(q)})`).join(' or ')}`, nested: false };
  }
  const q = qs[0]!;
  const inner = `@container ${VIEW_CONTAINER} ${container(q)}`;
  if (q.media.length === 0) return { head: inner, nested: false };
  return { head: `@media ${q.media.join(' and ')} { ${inner}`, nested: true };
}

/** `@media` size queries as `@container parallax-view` queries (see the file comment). */
export function containerQueries(css: string): string {
  let out = '';
  let depth = 0;
  /** Depths whose closing brace also closes an inner @container. */
  const extra: number[] = [];
  for (let i = 0; i < css.length;) {
    const end = protectedEnd(css, i);
    if (end >= 0) {
      out += css.slice(i, end);
      i = end;
      continue;
    }
    const c = css[i]!;
    if (c === '@' && /^@media\b/i.test(css.slice(i, i + 7))) {
      const open = css.indexOf('{', i);
      if (open > 0) {
        const rewritten = mediaHead(css.slice(i + 6, open).trim());
        if (rewritten !== undefined) {
          out += `${rewritten.head} {`;
          depth++;
          if (rewritten.nested) extra.push(depth);
          i = open + 1;
          continue;
        }
      }
    }
    if (c === '{') depth++;
    if (c === '}') {
      if (extra[extra.length - 1] === depth) {
        extra.pop();
        out += '}';
      }
      depth--;
    }
    out += c;
    i++;
  }
  return out;
}

/** A panel stylesheet measured against the game view. */
export function viewportCss(css: string): string {
  return containerUnits(containerQueries(css));
}
