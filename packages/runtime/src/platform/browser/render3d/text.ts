/**
 * World text → textures: each distinct text (spans and size) is laid out on a 2D canvas
 * once and kept while it is drawn. The quad's size in meters follows the canvas's aspect:
 * a line is `size` meters tall.
 */

import { fail } from '../../../core/index.js';
import type { Text3d, TextSpan } from '../../../core/index.js';
import type { TextTexture } from './plan.js';

/** Pixels per line of text in the texture. */
export const TEXT_LINE_PIXELS = 48;

export interface Context2dLike {
  font: string;
  fillStyle: unknown;
  textBaseline: string;
  measureText(text: string): { readonly width: number };
  fillText(text: string, x: number, y: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
}

export interface CanvasLike2d {
  width: number;
  height: number;
  getContext(kind: '2d'): Context2dLike | null;
}

export interface TextImage {
  readonly canvas: CanvasLike2d;
  readonly width: number;
  readonly height: number;
}

function css(span: TextSpan): string {
  const byte = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgba(${byte(span.color[0])}, ${byte(span.color[1])}, ${byte(span.color[2])}, ${Math.min(1, Math.max(0, span.color[3]))})`;
}

/** Spans split into lines at "\n". */
export function textLines(spans: readonly TextSpan[]): TextSpan[][] {
  const lines: TextSpan[][] = [[]];
  for (const span of spans) {
    span.text.split('\n').forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part !== '') lines[lines.length - 1]!.push({ ...span, text: part });
    });
  }
  return lines;
}

export function textKey(text: Text3d): string {
  return `text:${JSON.stringify(text.spans)}`;
}

export class TextRasterizer {
  readonly #canvas: (width: number, height: number) => CanvasLike2d;
  readonly #family: string;
  readonly #measure: Context2dLike;
  readonly #widths = new Map<string, number>();

  constructor(canvas: (width: number, height: number) => CanvasLike2d, family = 'system-ui, sans-serif') {
    this.#canvas = canvas;
    this.#family = family;
    const ctx = canvas(1, 1).getContext('2d');
    if (ctx === null) fail('PP9808', 'render3d needs a 2D canvas context to draw world text, and none is available', { fix: 'Use a browser with OffscreenCanvas 2D support.' });
    this.#measure = ctx;
  }

  #font(bold: boolean): string {
    return `${bold ? 'bold ' : ''}${Math.round(TEXT_LINE_PIXELS * 0.8)}px ${this.#family}`;
  }

  /** Pixel width of the widest line. */
  #width(text: Text3d): number {
    const key = textKey(text);
    let width = this.#widths.get(key);
    if (width === undefined) {
      width = 1;
      for (const line of textLines(text.spans)) {
        let w = 0;
        for (const span of line) {
          this.#measure.font = this.#font(span.bold);
          w += this.#measure.measureText(span.text).width;
        }
        width = Math.max(width, Math.ceil(w));
      }
      this.#widths.set(key, width);
    }
    return width;
  }

  /** The quad (meters) and texture ref for a text. */
  quad(text: Text3d): { readonly width: number; readonly height: number; readonly texture: TextTexture } {
    const lines = textLines(text.spans).length;
    return {
      width: (this.#width(text) / TEXT_LINE_PIXELS) * text.size,
      height: lines * text.size,
      texture: { id: textKey(text), text },
    };
  }

  raster(text: Text3d): TextImage {
    const lines = textLines(text.spans);
    const width = this.#width(text);
    const height = lines.length * TEXT_LINE_PIXELS;
    const canvas = this.#canvas(width, height);
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, width, height);
    ctx.textBaseline = 'middle';
    lines.forEach((line, row) => {
      let lineWidth = 0;
      for (const span of line) {
        ctx.font = this.#font(span.bold);
        lineWidth += ctx.measureText(span.text).width;
      }
      let x = (width - lineWidth) / 2;
      for (const span of line) {
        ctx.font = this.#font(span.bold);
        ctx.fillStyle = css(span);
        ctx.fillText(span.text, x, (row + 0.5) * TEXT_LINE_PIXELS);
        x += ctx.measureText(span.text).width;
      }
    });
    return { canvas, width, height };
  }
}
