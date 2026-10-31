import random

from parallax import System, on, system
from parallax.combat import Died
from project import Prefabs, Scenes

from game.build import find_wisp
from game.components import Bloom, Guardian, Wisp
from game.content import BloomDef


@system("drops", scenes=[Scenes.garden])
class Drops(System):
    """A guardian banished by sparks or a bomb may drop a bloom, by its wave's drop
    chance plus Forager's bonus. Which bloom is a weighted draw. Ramming one with
    the Wisp drops nothing."""

    @on(Died, where=lambda event: event.entity.has(Guardian))
    def guardian_died(self, ctx, event: Died):
        if event.source and event.source.has(Wisp):
            return
        chance = event.entity.get(Guardian).wave.data.drop_chance + find_wisp(ctx).get(Wisp).drop_bonus
        if random.random() >= chance:
            return
        blooms = ctx.content(BloomDef)
        kind = random.choices(blooms, weights=[b.data.weight for b in blooms])[0]
        ctx.world.spawn(Prefabs.bloom, at=event.entity.transform.position.xy(), components=[Bloom(kind=kind)])
