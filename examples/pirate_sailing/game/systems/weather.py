import random

from parallax import System, system
from project import Prefabs

from game.components import Squall
from game.config import Sounds, VoyageRules
from game.rules import current_leg, sailing


@system("weather", when=sailing)
class Weather(System):
    """Squalls blow up at the leg's own rate (the Bay is nearly calm, the Storm Reef
    almost never is) and blow out after a fixed spell. A squall is an entity: its
    EnvironmentZone darkens every client's sky and its rain loop plays while it exists,
    so ending one is destroying it."""

    def update(self, ctx, dt):
        squall = ctx.world.query(Squall).first()
        if squall is not None:
            entity, weather = squall
            if ctx.time.now >= weather.ends_at:
                entity.destroy()
                if current_leg(ctx).storm_chance < 0.5:  # the Storm Reef's gale never drops
                    ctx.wind.set(speed=11, gusts=0.2, seconds=6)
        elif random.random() < current_leg(ctx).storm_chance / 60 * dt:
            ends_at = ctx.time.now + ctx.config(VoyageRules).storm_duration
            ctx.world.spawn(Prefabs.squall, components=[Squall(ends_at=ends_at)])
            ctx.audio.play(ctx.config(Sounds).thunder)
            ctx.wind.set(speed=16, gusts=0.7, seconds=6)  # flags and pennants stream hard
