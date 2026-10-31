from parallax import System, on, system
from parallax.combat import Died
from project import Prefabs

from features.creatures.components import Wildlife
from features.creatures.resources import Herd
from features.creatures.spawning import ground_at, ground_block
from game.config import Rules
from game.world import the_player

GOLDEN_ANGLE = 137.5
"""Degrees between successive spawn headings, so spawns spread evenly round the player."""


@system("wildlife")
class Herds(System):
    """Keeps a small herd of grazers around the player on open grass. Strays that
    wander too far are let go, and a herd that loses one takes a while to regrow."""

    def update(self, ctx, dt):
        rules = ctx.config(Rules)
        herd = ctx.get(Herd)
        home = the_player(ctx).transform.position
        animals = ctx.world.query(tagged=Wildlife)
        for animal in animals:
            if (animal.transform.position - home).length() > rules.herd_leash:
                animal.destroy()
        herd.spawn_in -= dt
        if herd.spawn_in > 0 or animals.count() >= rules.herd_size:
            return
        herd.spawn_in = rules.herd_interval
        herd.spawned += 1
        spot = ground_at(ctx, home, rules.herd_radius, herd.spawned * GOLDEN_ANGLE)
        ground = ground_block(ctx, spot)
        if ground and ground.data.soil:
            ctx.world.spawn(Prefabs.sheep, at=spot)

    @on(Died, where=lambda event: event.entity.has(Wildlife))
    def lost_one(self, ctx, event: Died):
        ctx.get(Herd).spawn_in = ctx.config(Rules).herd_regrow
