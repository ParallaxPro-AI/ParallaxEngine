import random

from parallax import System, on, system
from project import Scenes

from game.config import House
from game.content import ConditionDef
from game.events import LegStarted
from game.resources import Air, Match


@system("draught", scenes=[Scenes.oche_hall])
class Draught(System):
    """The hall's crosswind. Rolled fresh for every leg — a weighted condition,
    scaled by the Tour tier, blowing left or right — then gusting around that
    speed, so a throw lined up in a lull can drift in a gust."""

    @on(LegStarted)
    def roll(self, ctx, event):
        air = ctx.get(Air)
        house = ctx.config(House)
        conditions = ctx.content(ConditionDef)
        air.condition = random.choices(conditions,weights=[c.data.weight for c in conditions])[0]
        rolled = random.uniform(air.condition.data.speed_min, air.condition.data.speed_max)
        air.leg_speed = rolled * ctx.get(Match).tier.data.draught_scale
        air.speed = air.leg_speed
        jitter = house.draught_bearing_jitter
        air.bearing = random.choice(house.draught_bearings) + random.uniform(-jitter, jitter)
        air.next_gust.restart(random.uniform(house.gust_seconds_min, house.gust_seconds_max))

    def update(self, ctx, dt):
        air = ctx.get(Air)
        if not air.next_gust.tick(dt):
            return
        house = ctx.config(House)
        drift = air.leg_speed * house.gust_spread
        air.speed = max(0.0, air.leg_speed + random.uniform(-drift, drift))
        air.next_gust.restart(random.uniform(house.gust_seconds_min, house.gust_seconds_max))
