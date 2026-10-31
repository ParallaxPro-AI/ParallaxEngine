/**
 * Paints a laid-out DOM subtree into a 2D canvas: what an in-world screen shows. The
 * browser lays the panel out (fonts, flex, grid, wrapping); this walks the result and
 * draws it with Canvas2D — backgrounds (with rounded corners), borders, images, text — so
 * the canvas stays untainted and uploadable as a texture. (An SVG `<foreignObject>`
 * snapshot would be simpler, but Chromium taints any canvas it is drawn into.)
 *
 * Drawn: background colors and linear gradients' first color, uniform borders, border
 * radius, opacity, `<img>` (same-origin or `data:`), text in its computed font, color and
 * alignment, one draw per laid-out line. Not drawn: shadows, transforms, filters,
 * background images other than colors, per-side border styles. Panels on screens should
 * keep to flat styling.
 */

function px(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function visibleColor(color: string): boolean {
  return color !== '' && color !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(color);
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (radius === 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** The first color stop of a `linear-gradient(...)` background, else null. */
function gradientColor(image: string): string | null {
  const match = /gradient\([^,]*?(rgba?\([^)]*\)|#[0-9a-f]{3,8}|[a-z]+)/i.exec(image);
  return match?.[1] ?? null;
}

function paintText(ctx: CanvasRenderingContext2D, node: Text, style: CSSStyleDeclaration, ox: number, oy: number): void {
  const text = node.data.replace(/\s+/g, ' ');
  if (text.trim() === '') return;
  const range = document.createRange();
  range.selectNodeContents(node);
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  if (rects.length === 0) return;
  ctx.font = style.font || `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  ctx.fillStyle = style.color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  if (rects.length === 1) {
    const r = rects[0]!;
    ctx.fillText(text.trim(), r.left - ox, r.top - oy + r.height / 2);
    return;
  }
  // Wrapped: fill each laid-out line with the words that fit its width.
  const words = text.trim().split(' ');
  let w = 0;
  for (const r of rects) {
    let line = '';
    while (w < words.length) {
      const next = line === '' ? words[w]! : `${line} ${words[w]}`;
      if (line !== '' && ctx.measureText(next).width > r.width + 1) break;
      line = next;
      w++;
    }
    ctx.fillText(line, r.left - ox, r.top - oy + r.height / 2);
  }
}

function paintElement(ctx: CanvasRenderingContext2D, el: Element, ox: number, oy: number, alpha: number): void {
  const style = getComputedStyle(el);
  if (style.display === 'none') return;
  const opacity = alpha * px(style.opacity === '' ? '1' : style.opacity);
  if (opacity <= 0) return;
  const hidden = style.visibility === 'hidden';
  const r = el.getBoundingClientRect();
  const x = r.left - ox;
  const y = r.top - oy;
  ctx.globalAlpha = opacity;
  if (!hidden && r.width > 0 && r.height > 0) {
    const radius = px(style.borderTopLeftRadius);
    const background = visibleColor(style.backgroundColor) ? style.backgroundColor : gradientColor(style.backgroundImage);
    if (background !== null && visibleColor(background)) {
      roundedRect(ctx, x, y, r.width, r.height, radius);
      ctx.fillStyle = background;
      ctx.fill();
    }
    const border = px(style.borderTopWidth);
    if (border > 0 && style.borderTopStyle !== 'none' && visibleColor(style.borderTopColor)) {
      roundedRect(ctx, x + border / 2, y + border / 2, r.width - border, r.height - border, Math.max(0, radius - border / 2));
      ctx.lineWidth = border;
      ctx.strokeStyle = style.borderTopColor;
      ctx.stroke();
    }
    if (el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0) ctx.drawImage(el, x, y, r.width, r.height);
  }
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (!hidden) {
        ctx.globalAlpha = opacity;
        paintText(ctx, child as Text, style, ox, oy);
      }
    } else if (child.nodeType === Node.ELEMENT_NODE && !(child instanceof HTMLStyleElement)) {
      paintElement(ctx, child as Element, ox, oy, opacity);
    }
  }
}

/** Paint `root` (laid out at the canvas's size) into `canvas`, over `background`. */
export function paintDom(root: HTMLElement, canvas: HTMLCanvasElement, background: string): void {
  const ctx = canvas.getContext('2d')!;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const origin = root.getBoundingClientRect();
  ctx.beginPath();
  ctx.rect(0, 0, canvas.width, canvas.height);
  ctx.clip();
  paintElement(ctx, root, origin.left, origin.top, 1);
  ctx.restore();
}
