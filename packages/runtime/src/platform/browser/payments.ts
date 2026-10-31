/**
 * The browser's payment host (core `PaymentHost`): the page around the game — the
 * product's play page, or a native shell's WebView bridge posing as one — sells over
 * `postMessage`. The game never sees a price it can change or a button that pays: it asks,
 * the host page shows its own confirm sheet, and deliveries come back.
 *
 * Protocol (JSON objects, `type` first; only messages from `origin` are heard):
 *
 *   game → host  {type: "parallax:payments", id, op: "catalog", products: ProductSpec[]}
 *                {type: "parallax:payments", id, op: "purchase", product}
 *                {type: "parallax:payments", id, op: "owned"}
 *                {type: "parallax:payments", id: 0, op: "confirm", purchases: string[]}
 *   host → game  {type: "parallax:payments:reply", id, ok: true, result} | {…, ok: false, error}
 *                {type: "parallax:payments:delivery", purchase, product}
 *
 * catalog's result is StoreProduct[], purchase's {status, message}, owned's string[].
 */

import type { PaymentDelivery, PaymentHost, ProductSpec, PurchaseAnswer, StoreProduct } from '../../core/index.js';

export interface HostPageOptions {
  /** The host's window (default `window.parent`). */
  readonly target?: Pick<Window, 'postMessage'>;
  /** The host page's origin: messages from anywhere else are ignored, and ours go only there. */
  readonly origin: string;
  /** Where replies arrive (default `window`). */
  readonly events?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** Simulated purchases (editor previews). */
  readonly test?: boolean;
  /** Seconds before an unanswered request fails (default 120: the player may take a while). */
  readonly timeout?: number;
}

const REQUEST = 'parallax:payments';
const REPLY = 'parallax:payments:reply';
const DELIVERY = 'parallax:payments:delivery';

export class HostPagePayments implements PaymentHost {
  readonly available = true;
  readonly test: boolean;
  readonly #target: Pick<Window, 'postMessage'>;
  readonly #origin: string;
  readonly #events: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  readonly #timeout: number;
  readonly #waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  #deliveries: PaymentDelivery[] = [];
  #next = 1;
  readonly #listener = (e: MessageEvent): void => this.#heard(e);

  constructor(options: HostPageOptions) {
    this.#target = options.target ?? window.parent;
    this.#origin = options.origin;
    this.#events = options.events ?? window;
    this.test = options.test ?? false;
    this.#timeout = options.timeout ?? 120;
    this.#events.addEventListener('message', this.#listener as EventListener);
  }

  #heard(e: MessageEvent): void {
    if (e.origin !== this.#origin) return;
    const data = e.data as Record<string, unknown> | null;
    if (typeof data !== 'object' || data === null) return;
    if (data['type'] === DELIVERY && typeof data['purchase'] === 'string' && typeof data['product'] === 'string') {
      this.#deliveries.push({ purchase: data['purchase'], product: data['product'] });
    } else if (data['type'] === REPLY && typeof data['id'] === 'number') {
      const waiting = this.#waiting.get(data['id']);
      if (waiting === undefined) return;
      this.#waiting.delete(data['id']);
      clearTimeout(waiting.timer);
      if (data['ok'] === true) waiting.resolve(data['result']);
      else waiting.reject(new Error(typeof data['error'] === 'string' ? data['error'] : 'The host refused the request.'));
    }
  }

  #ask(op: string, fields: Record<string, unknown>): Promise<unknown> {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        reject(new Error('The host page did not answer.'));
      }, this.#timeout * 1000);
      this.#waiting.set(id, { resolve, reject, timer });
      this.#target.postMessage({ type: REQUEST, id, op, ...fields }, this.#origin);
    });
  }

  async catalog(products: readonly ProductSpec[]): Promise<readonly StoreProduct[]> {
    const result = await this.#ask('catalog', { products });
    return Array.isArray(result) ? result.filter((p): p is StoreProduct => typeof p?.id === 'string') : [];
  }

  async purchase(product: string): Promise<PurchaseAnswer> {
    // The host's confirm sheet is outside the game: the engine's virtual cursor (a shop menu over
    // a locked pointer) can't reach it, so give the player the OS cursor. The game re-locks on its
    // next press once the menu is closed.
    const doc = (globalThis as { document?: { pointerLockElement?: Element | null; exitPointerLock?(): void } }).document;
    if (doc?.pointerLockElement != null) doc.exitPointerLock?.();
    try {
      const result = (await this.#ask('purchase', { product })) as Partial<PurchaseAnswer> | null;
      const status = result?.status;
      if (status === 'purchased' || status === 'already_owned' || status === 'cancelled' || status === 'failed' || status === 'pending') {
        return { status, message: typeof result?.message === 'string' ? result.message : null };
      }
      return { status: 'failed', message: 'The host page gave an unknown answer.' };
    } catch (error) {
      return { status: 'failed', message: (error as Error).message };
    }
  }

  async owned(): Promise<readonly string[]> {
    const result = await this.#ask('owned', {});
    return Array.isArray(result) ? result.filter((p): p is string => typeof p === 'string') : [];
  }

  takeDeliveries(): PaymentDelivery[] {
    const out = this.#deliveries;
    this.#deliveries = [];
    return out;
  }

  confirm(purchases: readonly string[]): void {
    this.#target.postMessage({ type: REQUEST, id: 0, op: 'confirm', purchases: [...purchases] }, this.#origin);
  }

  close(): void {
    this.#events.removeEventListener('message', this.#listener as EventListener);
    for (const waiting of this.#waiting.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error('Closed.'));
    }
    this.#waiting.clear();
  }
}
