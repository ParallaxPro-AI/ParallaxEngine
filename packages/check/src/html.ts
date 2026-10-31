/**
 * A small, tolerant HTML reader for panel markup: elements with their attributes, nesting
 * and line numbers. Enough to follow `data-*` bindings and `<template>` scoping; it does
 * not validate HTML.
 */

export interface HtmlElement {
  readonly tag: string;
  readonly attrs: ReadonlyMap<string, string>;
  readonly children: HtmlElement[];
  readonly line: number;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style']);
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function decode(text: string): string {
  return text.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

/** The document as a root element (`#root`) holding the top-level elements. */
export function parseHtml(source: string): HtmlElement {
  const root: HtmlElement = { tag: '#root', attrs: new Map(), children: [], line: 1 };
  const stack: HtmlElement[] = [root];
  let i = 0;
  let line = 1;
  const advance = (to: number): void => {
    for (let k = i; k < to; k++) if (source.charCodeAt(k) === 10) line++;
    i = to;
  };
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) break;
    advance(lt);
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      advance(end === -1 ? source.length : end + 3);
      continue;
    }
    if (source.startsWith('<!', i) || source.startsWith('<?', i)) {
      const end = source.indexOf('>', i);
      advance(end === -1 ? source.length : end + 1);
      continue;
    }
    if (source.startsWith('</', i)) {
      const end = source.indexOf('>', i);
      const name = source.slice(i + 2, end === -1 ? source.length : end).trim().toLowerCase();
      advance(end === -1 ? source.length : end + 1);
      const at = stack.map((e) => e.tag).lastIndexOf(name);
      if (at > 0) stack.length = at;
      continue;
    }
    const match = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(source.slice(i, i + 64));
    if (match === null) {
      advance(i + 1);
      continue;
    }
    const tag = match[1]!.toLowerCase();
    let end = i + match[0].length;
    let quote: string | null = null;
    while (end < source.length) {
      const ch = source[end]!;
      if (quote !== null) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      end++;
    }
    const body = source.slice(i + match[0].length, end);
    const attrs = new Map<string, string>();
    for (const attr of body.matchAll(ATTRIBUTE)) {
      attrs.set(attr[1]!.toLowerCase(), decode(attr[2] ?? attr[3] ?? attr[4] ?? ''));
    }
    const element: HtmlElement = { tag, attrs, children: [], line };
    stack[stack.length - 1]!.children.push(element);
    advance(Math.min(end + 1, source.length));
    if (RAW_TEXT.has(tag)) {
      const close = source.toLowerCase().indexOf(`</${tag}`, i);
      advance(close === -1 ? source.length : close);
      continue;
    }
    if (!VOID.has(tag) && !body.trimEnd().endsWith('/')) stack.push(element);
  }
  return root;
}
