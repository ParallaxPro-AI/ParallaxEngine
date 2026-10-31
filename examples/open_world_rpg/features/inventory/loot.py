"""Rolling a loot table into pickups on the ground."""

import random

from parallax import Context, Vec3, vec3

from features.inventory.content import LootTableDef


def scatter_loot(ctx: Context, table: LootTableDef, at: Vec3) -> None:
    weights = [entry.weight for entry in table.entries]
    for _ in range(table.rolls):
        entry = random.choices(table.entries, weights=weights)[0]
        if entry.prefab is None:
            continue
        offset = vec3(random.uniform(-1, 1), 0, random.uniform(-1, 1)) * table.scatter
        ctx.world.spawn(entry.prefab, at=ctx.terrain.ground(at + offset))
