"""Rolling loot tables and scattering the pickups."""

import random

from parallax import Context, ContentRef, Vec3, scatter
from project import Prefabs

from game.components import Pickup
from game.content import LootTable
from game.rules import Rules


def drop_loot(ctx: Context, table: ContentRef[LootTable], at: Vec3) -> None:
    drops = table.data.drops
    for _ in range(table.data.rolls):
        drop = random.choices(drops, weights=[d.weight for d in drops])[0]
        if drop.item is None:
            continue
        for spot in scatter(at, ctx.config(Rules).loot_scatter, random.randint(*drop.count)):
            ctx.world.spawn(Prefabs.pickup, at=spot, components=[Pickup(item=drop.item)])
