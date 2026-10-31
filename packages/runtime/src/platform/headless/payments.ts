/**
 * A scripted payment host (core `PaymentHost`) for playtests and editor previews: answers
 * purchases the way a test says, delivers what it "sold", and records every request and
 * confirmation. Answers resolve as promises (a microtask later), like a real host's.
 */

import type { PaymentDelivery, PaymentHost, ProductSpec, PurchaseAnswer, PurchaseStatus, StoreProduct } from '../../core/index.js';

export interface FakePaymentOptions {
  readonly available?: boolean;
  /** Default true: a preview host (nothing charged). */
  readonly test?: boolean;
  /** Permanent products the player already owns. */
  readonly owned?: readonly string[];
  /** How the host answers a purchase of `product` (default: 'purchased'). */
  readonly answer?: (product: string) => PurchaseStatus;
  /** Display price per product (default: "<price> Plux"). */
  readonly price?: (product: ProductSpec) => string | null;
}

export class FakePaymentHost implements PaymentHost {
  readonly available: boolean;
  readonly test: boolean;
  /** Every purchase asked for, in order. */
  readonly requests: string[] = [];
  /** Every purchase id confirmed, in order. */
  readonly confirmed: string[] = [];
  readonly #owned: Set<string>;
  readonly #answer: (product: string) => PurchaseStatus;
  readonly #price: (product: ProductSpec) => string | null;
  readonly #kinds = new Map<string, ProductSpec['kind']>();
  #deliveries: PaymentDelivery[] = [];
  /** Delivered, not yet confirmed (a real host redelivers these on the next run). */
  readonly #unconfirmed = new Map<string, PaymentDelivery>();
  #sequence = 0;

  constructor(options: FakePaymentOptions = {}) {
    this.available = options.available ?? true;
    this.test = options.test ?? true;
    this.#owned = new Set(options.owned ?? []);
    this.#answer = options.answer ?? (() => 'purchased');
    this.#price = options.price ?? ((p) => `${p.price} Plux`);
  }

  async catalog(products: readonly ProductSpec[]): Promise<readonly StoreProduct[]> {
    for (const p of products) this.#kinds.set(p.id, p.kind);
    return products.map((p) => ({ id: p.id, price: this.available ? this.#price(p) : null }));
  }

  async purchase(product: string): Promise<PurchaseAnswer> {
    this.requests.push(product);
    if (!this.available) return { status: 'failed', message: 'Purchases are not available here.' };
    if (this.#kinds.get(product) === 'permanent' && this.#owned.has(product)) return { status: 'already_owned', message: null };
    const status = this.#answer(product);
    if (status === 'purchased') {
      if (this.#kinds.get(product) === 'permanent') this.#owned.add(product);
      this.deliver(product);
    }
    return { status, message: status === 'failed' ? 'The purchase did not go through.' : null };
  }

  async owned(): Promise<readonly string[]> {
    return [...this.#owned].sort();
  }

  /** Make a delivery as if a purchase went through (or one from an earlier session). */
  deliver(product: string): PaymentDelivery {
    const delivery = { purchase: `test-${++this.#sequence}`, product };
    this.#deliveries.push(delivery);
    this.#unconfirmed.set(delivery.purchase, delivery);
    return delivery;
  }

  /** Deliveries handed over but never confirmed (what a real host would redeliver next run). */
  get unconfirmed(): readonly PaymentDelivery[] {
    return [...this.#unconfirmed.values()];
  }

  takeDeliveries(): PaymentDelivery[] {
    const out = this.#deliveries;
    this.#deliveries = [];
    return out;
  }

  confirm(purchases: readonly string[]): void {
    for (const id of purchases) {
      this.confirmed.push(id);
      this.#unconfirmed.delete(id);
    }
  }

  /** A new session on the same account: unconfirmed deliveries come again. */
  restart(): void {
    this.#deliveries = [...this.#unconfirmed.values()];
  }
}
