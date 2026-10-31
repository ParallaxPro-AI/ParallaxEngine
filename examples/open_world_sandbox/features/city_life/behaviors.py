"""A pedestrian."""

import random

from parallax import Behavior, Vec3, behavior, on, param, state
from parallax.combat import Damaged, Died, Health
from parallax.city import CityWalker
from parallax.nav import Arrived, NavAgent

from features.city_life.config import Street

from features.on_foot.feature import WeaponFired
from game.audio import Sounds, play


@behavior("pedestrian", requires=[NavAgent, Health], tick="significance")
class PedestrianLife(Behavior):
    """A hand-placed pedestrian strolls between random points near home, pausing now and then; one the
    city spawned (`CityWalker`) walks the sidewalks instead, and this only adds getting hurt. Gunfire
    within earshot, or being hurt, sends them running away from the danger. The fallen stay down a
    while."""

    walk_speed: float = param(2, unit="m/s")
    flee_speed: float = param(6, unit="m/s")
    wander_radius: float = param(30, unit="m")
    pause: float = param(2, unit="s", doc="Longest pause between strolls.")
    hearing: float = param(30, unit="m")
    flee_distance: float = param(35, unit="m")
    corpse_seconds: float = param(10, unit="s")
    home: Vec3 = state(Vec3.ZERO)
    resting: float = state(0.0)

    def start(self, ctx):
        self.home = self.entity.transform.position
        if not self.city_walked():
            self.stroll(ctx)

    def city_walked(self) -> bool:
        return self.entity.has(CityWalker) and self.entity.get(CityWalker).active

    @on(Arrived)
    def arrived(self, ctx, event: Arrived):
        self.entity.get(NavAgent).speed = self.walk_speed
        self.resting = random.uniform(0, self.pause)

    @on(WeaponFired)
    def gunfire(self, ctx, event: WeaponFired):
        if not self.city_walked() and self.entity.transform.position.distance_to(event.at) <= self.hearing:
            self.flee(ctx, event.at)

    @on(Damaged)
    def wounded(self, ctx, event: Damaged):
        if event.source is None:
            return
        if self.city_walked():
            street = ctx.config(Street)
            ctx.city.alarm(event.source.transform.position, radius=street.panic_radius, seconds=street.panic_seconds)
        else:
            self.flee(ctx, event.source.transform.position)

    @on(Died)
    def fall(self, ctx, event: Died):
        play(ctx, ctx.config(Sounds).pedestrian_down, at=self.entity)
        if self.entity.has(CityWalker):
            self.entity.get(CityWalker).active = False
        self.entity.get(NavAgent).stop()
        self.entity.destroy(after=self.corpse_seconds)

    def update(self, ctx, dt):
        if self.city_walked() or self.entity.get(Health).dead or self.entity.get(NavAgent).moving:
            return
        self.resting -= dt
        if self.resting <= 0:
            self.stroll(ctx)

    def stroll(self, ctx):
        point = ctx.nav.random_point(self.home, self.wander_radius)
        if point is not None:
            self.entity.get(NavAgent).move_to(point)

    def flee(self, ctx, danger: Vec3):
        if self.entity.get(Health).dead:
            return
        away = (self.entity.transform.position - danger).flat().normalized()
        point = ctx.nav.random_point(self.entity.transform.position + away * self.flee_distance, 6)
        agent = self.entity.get(NavAgent)
        agent.speed = self.flee_speed
        if point is not None:
            agent.move_to(point)
