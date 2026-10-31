/**
 * The payments port: in-game purchases, sold by whoever hosts the game — never inside the
 * game realm. Game code asks (`ctx.payments.buy`); the host page (a platform's play page,
 * which shows a confirm sheet the game can't touch) or the native shell (store billing)
 * decides, charges and delivers. The engine only relays requests and hands deliveries to
 * the game's handlers.
 *
 * Deliveries are the source of truth for granting: a purchase that went through arrives
 * as a delivery (now, or on a later run if the game closed before it was granted), and is
 * confirmed only after the game's handlers ran — so a consumable is granted exactly once.
 * The `purchase` answer is only feedback for the buy button (cancelled, failed, owned).
 *
 * `available` false is an expected state (dedicated servers, offline exports, guests): the
 * game hides its store. Adapters: `platform/browser/payments.ts` (the host page over
 * postMessage), `platform/headless/payments.ts` (a scripted fake for tests and previews).
 */

export type ProductKind = 'consumable' | 'permanent';

/** What the game declares for sale (`content/product/*.json`). */
export interface ProductSpec {
  readonly id: string;
  readonly kind: ProductKind;
  /** The list price in the platform's currency (whole units), as the game's data says. */
  readonly price: number;
  /** Shown on the host's confirm sheet, in the player's language. */
  readonly name: string;
  readonly description: string;
}

/** A product as the host sells it now. */
export interface StoreProduct {
  readonly id: string;
  /** Display price, localized by the host ("120 Plux", "$0.99"); null when it can't sell it. */
  readonly price: string | null;
}

export type PurchaseStatus = 'purchased' | 'already_owned' | 'cancelled' | 'failed' | 'pending';

export interface PurchaseAnswer {
  readonly status: PurchaseStatus;
  /** Why it failed, safe to show the player ("Not enough Plux."); null otherwise. */
  readonly message: string | null;
}

export interface PaymentDelivery {
  /** Unique per purchase: the host never delivers the same one twice once confirmed. */
  readonly purchase: string;
  readonly product: string;
}

export interface PaymentHost {
  /** Whether purchases can happen here at all. */
  readonly available: boolean;
  /** Simulated purchases (editor previews): nothing is charged. */
  readonly test: boolean;
  /** Tell the host what the game sells (once at start); resolves with its prices. */
  catalog(products: readonly ProductSpec[]): Promise<readonly StoreProduct[]>;
  /** Ask the host to sell a product (the player confirms on the host's own UI). */
  purchase(product: string): Promise<PurchaseAnswer>;
  /** Permanent products the player owns (restored on every device). */
  owned(): Promise<readonly string[]>;
  /** Purchases ready to grant since the last call (pull: the engine drains them each frame). */
  takeDeliveries(): PaymentDelivery[];
  /** The game granted these: never deliver them again. */
  confirm(purchases: readonly string[]): void;
}
