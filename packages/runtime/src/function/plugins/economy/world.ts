/**
 * Pickups: the economy's thing in the world, driven each frame. (Doors moved to the
 * interaction plugin, spawners to the spawning plugin, projectiles to combat.)
 *
 * A `Pickup` holds `count` of an `item` (collected into an Inventory) or of a wallet
 * `pool` (into a Wallet). Each frame the nearest entity that can take it (has the
 * Inventory / Wallet, and `collector_tag` when set) within `radius` meters collects it:
 * as much as fits; the rest stays on the ground. Within `magnet` meters it flies to that
 * collector at `magnet_speed`. Collected, it is destroyed — or, with `respawn`, hidden
 * (`respawn_at`) and shown again where it lay that many seconds later. Distances are
 * between world positions; no physics is involved, so pickups work in 2D, 3D and
 * data-only playtests alike. A magnet pickup should not carry a dynamic Rigidbody.
 */

import { fail } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { EntityRecord } from '../../kernel/index.js';
import { idOf } from './args.js';
import { add } from './inventory.js';
import { ECONOMY_EVENTS, INVENTORY, ITEM, PICKUP, WALLET } from './schemas.js';
import { rows } from './state.js';
import type { EconomyState } from './state.js';

export function tickPickups(s: EconomyState, dt: number): void {
  const kernel = s.kernel;
  const now = kernel.time.now;
  for (const [id, p] of rows(kernel, PICKUP)) {
    const record = kernel.world.get(id)!;
    const back = p['respawn_at'] as number;
    if (back >= 0) {
      if (now >= back) {
        p['respawn_at'] = -1;
        record.visible = true;
      }
      continue;
    }
    const item = idOf(p['item']);
    const pool = idOf(p['pool']);
    if ((item === null) === (pool === null)) {
      fail('PP7150', `${s.where(id, PICKUP)} needs exactly one of "item" or "pool"`, { fix: 'Set "item": "<item id>" or "pool": "gold".' });
    }
    const takes = item !== null ? INVENTORY : WALLET;
    const tag = idOf(p['collector_tag']);
    const at = record.transform.worldPosition();
    let best: { id: EntityId; record: EntityRecord; d: number } | undefined;
    const reach = Math.max(p['radius'] as number, p['magnet'] as number);
    for (const [cid] of kernel.world.query([takes], tag === null ? {} : { tagged: [tag] })) {
      if (cid === id) continue;
      const c = kernel.world.get(cid)!;
      const d = c.transform.worldPosition().distance_to(at);
      if (d <= reach && (best === undefined || d < best.d)) best = { id: cid, record: c, d };
    }
    if (best === undefined) continue;
    if (best.d > (p['radius'] as number)) {
      const to = best.record.transform.worldPosition().__sub__(at);
      const step = Math.min(best.d, (p['magnet_speed'] as number) * dt);
      record.transform.setWorldPosition(at.__add__(to.__mul__(step / best.d)));
      continue;
    }
    const n = p['count'] as number;
    let taken: number;
    if (item !== null) taken = n - add(s, best.id, best.record.components.get(INVENTORY)!, item, Math.floor(n));
    else taken = s.earn(best.id, best.record.components.get(WALLET)!, pool!, n);
    if (taken <= 0) continue;
    s.emit(ECONOMY_EVENTS.pickedUp, { entity: s.wrap(id), source: s.wrap(best.id), item: s.ref(ITEM, item), pool, count: taken });
    if (taken < n) {
      p['count'] = n - taken;
      continue;
    }
    const respawn = p['respawn'];
    if (typeof respawn === 'number') {
      p['respawn_at'] = now + respawn;
      record.visible = false;
    } else {
      kernel.destroy(id);
    }
  }
}
