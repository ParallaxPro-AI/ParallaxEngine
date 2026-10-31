/**
 * payments — in-game purchases through the host (sdk/parallax/payments.pyi; core
 * `PaymentHost`). Products are content: `content/product/<id>.json` (the built-in `product`
 * kind: name, description, kind consumable | permanent, price). The game asks with
 * `ctx.payments.buy(product)`; the host page or native shell sells it on its own UI.
 *
 * Everything the host says enters the game at the start of a frame (the 'input' hook), in
 * the order it arrived, so handlers run inside normal frames:
 *
 *   purchase_completed  a delivery: grant it now (a consumable each time, a permanent once).
 *                       It is confirmed to the host after the frame — only if the frame's
 *                       handlers ran without an error — so a crash never loses a purchase
 *                       and a grant never repeats.
 *   purchase_failed     the buy didn't go through: reason cancelled | failed | already_owned
 *                       | unavailable (no host here) | pending (the host will deliver later).
 *
 * Owned permanent products are this plugin's state (restored from the host at start, and
 * on every delivery), in snapshots; prices are the host's display strings.
 */

import { fail } from '../../../core/index.js';
import type { PaymentDelivery, PaymentHost, ProductKind, ProductSpec, PurchaseAnswer } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import type { EventDef, Kernel, KernelPlugin } from '../../kernel/index.js';

export const PRODUCT_KIND = 'product';

export const PAYMENT_EVENTS = {
  completed: { id: 'purchase_completed' },
  failed: { id: 'purchase_failed' },
} as const satisfies Record<string, EventDef>;

export const FAIL_REASONS = ['cancelled', 'failed', 'already_owned', 'unavailable', 'pending'] as const;
export type FailReason = (typeof FAIL_REASONS)[number];

export interface PaymentsHost {
  /** The game-facing ref of product `id` (a `ContentRef[ProductDef]`). */
  product(kernel: Kernel, id: string): unknown;
  /** The product's name and description in the player's language. */
  describe(kernel: Kernel, id: string): { readonly name: string; readonly description: string };
}

export interface PaymentsEngine {
  readonly available: boolean;
  readonly test: boolean;
  /** The host answered the catalog (prices known). */
  readonly ready: boolean;
  /** Ask to buy; false (and a purchase_failed next frame) when it can't be asked. */
  buy(product: string): boolean;
  owns(product: string): boolean;
  /** The host's display price, or null (not ready, not for sale, no host). */
  price(product: string): string | null;
  /** A buy is waiting for the host's answer. */
  pending(product: string): boolean;
  /** The products the game declares, by id. */
  products(): readonly ProductSpec[];
}

export interface PaymentsPlugin extends KernelPlugin {
  readonly engine: PaymentsEngine;
  /** The platform's host (boot connects it before the game starts; none: unavailable). */
  connect(host: PaymentHost): void;
}

type Arrival =
  | { readonly kind: 'answer'; readonly product: string; readonly answer: PurchaseAnswer }
  | { readonly kind: 'catalog'; readonly prices: ReadonlyMap<string, string | null> }
  | { readonly kind: 'owned'; readonly owned: readonly string[] };

export function payments(options: { readonly host: PaymentsHost }): PaymentsPlugin {
  let host: PaymentHost | undefined;
  let installed: Kernel | undefined;
  let specs: ProductSpec[] | undefined;
  const owned = new Set<string>();
  const prices = new Map<string, string | null>();
  const waiting = new Set<string>();
  let ready = false;
  let arrivals: Arrival[] = [];
  /** Refusals decided here (no host, already owned), raised at the next input hook. */
  let refusals: { product: string; reason: FailReason; message: string | null }[] = [];
  let granted: string[] = [];
  let started = false;

  const kernelOf = (): Kernel => {
    if (installed === undefined) fail('PP9343', 'payments is used before its kernel was built');
    return installed;
  };

  const productSpecs = (): ProductSpec[] => {
    if (specs !== undefined) return specs;
    const kernel = kernelOf();
    const entries = kernel.project.content.get(PRODUCT_KIND);
    const list: ProductSpec[] = [];
    for (const entry of entries?.values() ?? []) {
      const data = entry.values;
      const kind = (data['kind'] ?? 'consumable') as ProductKind;
      const price = data['price'] ?? 0;
      if (kind !== 'consumable' && kind !== 'permanent') {
        fail('PP3344', `product "${entry.id}" kind is ${JSON.stringify(kind)}`, { path: entry.path, fix: 'Write "consumable" or "permanent".' });
      }
      if (typeof price !== 'number' || !Number.isInteger(price) || price < 0) {
        fail('PP3344', `product "${entry.id}" price is ${JSON.stringify(price)}`, { path: entry.path, fix: 'Give a whole number of at least 0 (the platform currency).' });
      }
      list.push({ id: entry.id, kind, price, ...options.host.describe(kernel, entry.id) });
    }
    specs = list.sort((a, b) => (a.id < b.id ? -1 : 1));
    return specs;
  };

  const spec = (id: string): ProductSpec => {
    const found = productSpecs().find((p) => p.id === id);
    if (found === undefined) {
      fail('PP3345', `There is no product "${id}"`, { fix: 'Add content/product/<id>.json, and refer to it as Content.product.<id>.' });
    }
    return found;
  };

  const startHost = (): void => {
    if (started || host === undefined || !host.available) return;
    started = true;
    const h = host;
    void h.catalog(productSpecs()).then(
      (list) => { arrivals.push({ kind: 'catalog', prices: new Map(list.map((p) => [p.id, p.price])) }); },
      () => { arrivals.push({ kind: 'catalog', prices: new Map() }); },
    );
    void h.owned().then((list) => { arrivals.push({ kind: 'owned', owned: list }); }, () => undefined);
  };

  const emitFailed = (kernel: Kernel, product: string, reason: FailReason, message: string | null): void => {
    kernel.emit(PAYMENT_EVENTS.failed, { product: options.host.product(kernel, product), reason, message: message ?? '' });
  };

  const drain = (kernel: Kernel): void => {
    startHost();
    for (const r of refusals) emitFailed(kernel, r.product, r.reason, r.message);
    refusals = [];
    const now = arrivals;
    arrivals = [];
    for (const a of now) {
      if (a.kind === 'catalog') {
        prices.clear();
        for (const [id, price] of a.prices) prices.set(id, price);
        ready = true;
      } else if (a.kind === 'owned') {
        for (const id of a.owned) if (productSpecs().some((p) => p.id === id && p.kind === 'permanent')) owned.add(id);
      } else {
        waiting.delete(a.product);
        // A purchase that went through is granted by its delivery, not by this answer.
        if (a.answer.status !== 'purchased') emitFailed(kernel, a.product, a.answer.status, a.answer.message);
      }
    }
    if (host === undefined) return;
    for (const d of host.takeDeliveries()) deliver(kernel, d);
  };

  const deliver = (kernel: Kernel, d: PaymentDelivery): void => {
    const found = productSpecs().find((p) => p.id === d.product);
    // A delivery for a product this build doesn't declare stays with the host, unconfirmed.
    if (found === undefined) return;
    if (found.kind === 'permanent') owned.add(found.id);
    kernel.emit(PAYMENT_EVENTS.completed, { product: options.host.product(kernel, found.id), purchase: d.purchase });
    granted.push(d.purchase);
  };

  const engine: PaymentsEngine = {
    get available() { return host?.available === true; },
    get test() { return host?.test === true; },
    get ready() { return ready; },
    buy(product) {
      const p = spec(product);
      if (host === undefined || !host.available) {
        refusals.push({ product, reason: 'unavailable', message: null });
        return false;
      }
      if (p.kind === 'permanent' && owned.has(product)) {
        refusals.push({ product, reason: 'already_owned', message: null });
        return false;
      }
      if (waiting.has(product)) return false;
      waiting.add(product);
      void host.purchase(product).then(
        (answer) => { arrivals.push({ kind: 'answer', product, answer }); },
        (error: unknown) => { arrivals.push({ kind: 'answer', product, answer: { status: 'failed', message: error instanceof Error ? error.message : null } }); },
      );
      return true;
    },
    owns: (product) => spec(product).kind === 'permanent' && owned.has(product),
    price: (product) => (spec(product), prices.get(product) ?? null),
    pending: (product) => (spec(product), waiting.has(product)),
    products: () => productSpecs(),
  };

  return {
    id: 'payments',
    events: Object.values(PAYMENT_EVENTS),
    engine,
    connect(next) {
      if (started) fail('PP3343', 'payments: a host was connected after the game asked the first one', { fix: 'Connect the payment host before the game starts.' });
      host = next;
    },
    install(kernel) {
      if (installed !== undefined) fail('PP3343', 'This payments plugin is already installed in another kernel', { fix: 'Call payments() once per game.' });
      installed = kernel;
      kernel.addHook('input', () => drain(kernel));
    },
    afterFrame() {
      if (granted.length === 0 || host === undefined) return;
      const done = granted;
      granted = [];
      host.confirm(done);
    },
    snapshot: (): Json => ({ owned: [...owned].sort() }),
    restore(_kernel, state) {
      owned.clear();
      for (const id of (state as JsonObject)['owned'] as string[]) owned.add(id);
    },
  };
}
