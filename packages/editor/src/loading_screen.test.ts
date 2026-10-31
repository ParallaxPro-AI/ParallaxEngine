import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadingFraction, showEditorLoading } from './loading_screen.js';

class FakeElement {
  readonly style: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly classes = new Set<string>();
  readonly classList = { add: (c: string) => { this.classes.add(c); } };
  readonly ownerDocument = { defaultView: { getComputedStyle: () => ({ position: 'static' }) } };
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  textContent = '';
  constructor(readonly tagName: string) {}
  set className(value: string) { for (const c of value.split(' ')) this.classes.add(c); }
  addEventListener(): void {}
  append(...nodes: FakeElement[]): void { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  remove(): void {
    if (this.parent !== null) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  find(className: string): FakeElement | undefined {
    if (this.classes.has(className)) return this;
    for (const c of this.children) { const hit = c.find(className); if (hit !== undefined) return hit; }
    return undefined;
  }
}

describe('loadingFraction', () => {
  it('clamps and never goes back', () => {
    expect(loadingFraction(0, 0.4)).toBe(0.4);
    expect(loadingFraction(0.4, 0.2)).toBe(0.4);
    expect(loadingFraction(0, 3)).toBe(1);
    expect(loadingFraction(0.1, Number.NaN)).toBe(0.1);
  });
});

describe('showEditorLoading', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('document', { createElement: (tag: string) => new FakeElement(tag) });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows progress and text, then fades out and leaves', () => {
    const root = new FakeElement('div');
    const loading = showEditorLoading(root as unknown as HTMLElement);
    const curtain = root.find('editor-loading')!;
    expect(root.style.position).toBe('relative');
    expect(curtain.find('editor-loading-text')!.textContent).toBe('Loading…');

    loading.progress(0.5, 'Starting engine');
    expect(curtain.find('editor-loading-text')!.textContent).toBe('Starting engine');
    expect(curtain.find('editor-loading-fill')!.style.width).toBe('50.0%');
    expect(curtain.attributes['aria-valuenow']).toBe('50');
    loading.progress(0.3);
    expect(curtain.find('editor-loading-fill')!.style.width).toBe('50.0%');
    expect(curtain.find('editor-loading-text')!.textContent).toBe('Starting engine');

    loading.done();
    loading.done();
    expect(curtain.find('editor-loading-fill')!.style.width).toBe('100.0%');
    expect(curtain.classes.has('editor-loading-done')).toBe(true);
    expect(root.children).toHaveLength(1);
    vi.advanceTimersByTime(400);
    expect(root.children).toHaveLength(0);
    loading.progress(0.2, 'late');
    expect(curtain.find('editor-loading-text')!.textContent).toBe('Starting engine');
  });
});
