/**
 * `parallax.payments` (sdk/parallax/payments.pyi): the built-in `product` content kind
 * (`ProductDef`), `PaymentsApi` (the type of `ctx.payments`), the PurchaseCompleted and
 * PurchaseFailed events and the `payments()` factory `parallax.plugins` re-exports. Purchases
 * go through the platform's `PaymentHost` (boot connects it: `connectPayments`).
 */

import { bindArgs, fail } from '../core/index.js';
import type { PaymentHost } from '../core/index.js';
import type { Kernel, KernelPlugin } from '../function/kernel/index.js';
import { PAYMENT_EVENTS, payments as paymentsPlugin } from '../function/plugins/payments/index.js';
import type { PaymentsEngine, PaymentsPlugin } from '../function/plugins/payments/index.js';
import { ContentRef } from './content.js';
import type { Context } from './context.js';
import { content, declareBuiltIns } from './declarations.js';
import { eventHandle } from './events.js';
import { kw } from './kwargs.js';
import { field, Localized, rt } from './types.js';

class ProductDefFields {
  static readonly __annotations__ = {
    name: () => Localized,
    description: () => Localized,
    kind: () => rt.literal('consumable', 'permanent'),
    price: () => rt.int,
  };
  static readonly description = field('');
  static readonly kind = field('consumable', kw({ doc: 'consumable: bought again and again (coins); permanent: owned once (no ads, a skin).' }));
  static readonly price = field(0, kw({ min: 0, doc: 'List price in the platform currency (whole units).' }));
}

/** Built-in content kind: `content/product/<id>.json`, what the game sells. */
export const ProductDef = declareBuiltIns(() => content('product')(ProductDefFields), 'payments');

/** `@on(PurchaseCompleted)`: product, purchase (its id). Grant it here. */
export const PurchaseCompleted = eventHandle(PAYMENT_EVENTS.completed, 'PurchaseCompleted');
/** `@on(PurchaseFailed)`: product, reason (cancelled, failed, already_owned, unavailable, pending), message. */
export const PurchaseFailed = eventHandle(PAYMENT_EVENTS.failed, 'PurchaseFailed');

function productRef(kernel: Kernel, id: string): ContentRef<unknown> {
  return (kernel.context as Context).content(ProductDef).get(id);
}

function productId(value: unknown, where: string): string {
  if (value instanceof ContentRef && value.kind === 'product') return value.id;
  return fail('PP3345', `${where} takes a product (Content.product.<id>), got ${value === null || value === undefined ? 'None' : String(value)}`, {
    fix: 'Pass Content.product.<id> (content/product/<id>.json).',
  });
}

/** `ctx.payments`: the store, sold by the host page or native shell. */
export class PaymentsApi {
  readonly #engine: PaymentsEngine;

  constructor(engine: PaymentsEngine) {
    this.#engine = engine;
  }

  /** Purchases can happen here (false on servers, offline exports, guests: hide the store). */
  get available(): boolean { return this.#engine.available; }
  /** Purchases are simulated (editor previews): nothing is charged. */
  get test_mode(): boolean { return this.#engine.test; }
  /** The host answered with its prices. */
  get ready(): boolean { return this.#engine.ready; }

  /** Ask to buy; the answer is PurchaseCompleted or PurchaseFailed. False when it couldn't be asked. */
  buy(...args: unknown[]): boolean {
    const a = bindArgs('buy', args, { positional: ['product'], required: ['product'] }).args;
    return this.#engine.buy(productId(a['product'], 'buy()'));
  }

  /** Whether the player owns a permanent product. */
  owns(...args: unknown[]): boolean {
    const a = bindArgs('owns', args, { positional: ['product'], required: ['product'] }).args;
    return this.#engine.owns(productId(a['product'], 'owns()'));
  }

  /** The host's display price ("120 Plux"), or None (not ready, not for sale). */
  price(...args: unknown[]): string | null {
    const a = bindArgs('price', args, { positional: ['product'], required: ['product'] }).args;
    return this.#engine.price(productId(a['product'], 'price()'));
  }

  /** A buy of this product is waiting for the host. */
  pending(...args: unknown[]): boolean {
    const a = bindArgs('pending', args, { positional: ['product'], required: ['product'] }).args;
    return this.#engine.pending(productId(a['product'], 'pending()'));
  }
}

/** `parallax.plugins.payments()`. */
export function payments(...args: unknown[]): KernelPlugin {
  bindArgs('payments', args, {});
  const plugin = paymentsPlugin({
    host: {
      product: productRef,
      describe: (kernel, id) => {
        const ctx = kernel.context as Context;
        const data = productRef(kernel, id).data as { name: unknown; description: unknown };
        const text = (v: unknown): string => (v instanceof Localized ? ctx.text(v) : String(v ?? ''));
        return { name: text(data.name), description: text(data.description) };
      },
    },
  });
  return Object.assign(plugin, { namespace: { name: 'payments', create: () => new PaymentsApi(plugin.engine) } });
}

/** Boot: give the game's payments plugin (if it lists one) the platform's host. */
export function connectPayments(plugins: readonly KernelPlugin[], host: PaymentHost): void {
  for (const p of plugins) if (p.id === 'payments') (p as PaymentsPlugin).connect(host);
}
