import random
from enum import Enum

from parallax import Behavior, Vec3, behavior, param, state
from parallax.combat import Health
from project import Assets

from game.config import Sounds
from game.components import CrewShip
from game.rules import current_leg, sailing


class Dive(Enum):
    HIDDEN = "hidden"
    SURFACING = "surfacing"
    LASHING = "lashing"
    SUBMERGING = "submerging"


@behavior("sea_monster", requires=[Health], when=sailing)
class SeaMonster(Behavior):
    """A kraken tentacle or a reef shark. It lurks below its spot until a ship comes
    close, rises, lashes every crew ship within reach for a few beats, and sinks back
    to wait. It never leaves its spot; it only goes up and down."""

    sight: float = param(24, unit="m")
    reach: float = param(9, unit="m")
    damage: float = param(22)
    lash_every: float = param(1, unit="s")
    hidden_depth: float = param(-3, unit="m")
    surfaced_height: float = param(1.2, unit="m")
    rise_time: float = param(1.5, unit="s")
    lash_time: float = param(1.2, unit="s")
    sink_time: float = param(1.7, unit="s")
    rest_time: float = param(7, unit="s", doc="Plus up to 4 s of random patience.")

    dive: Dive = state(Dive.HIDDEN)
    phase_ends: float = state(0.0)
    next_lash: float = state(0.0)

    def start(self, ctx):
        self.entity.transform.position = self.at_height(self.hidden_depth)
        self.phase_ends = ctx.time.now + self.rest_time

    def update(self, ctx, dt):
        if self.dive is Dive.LASHING:
            self.keep_lashing(ctx)
        elif ctx.time.now >= self.phase_ends:
            self.next_phase(ctx)

    def next_phase(self, ctx):
        if self.dive is Dive.HIDDEN:
            if self.ships_within(ctx, self.sight):
                self.enter(ctx, Dive.SURFACING, self.rise_time)
                self.entity.transform.move_to(self.at_height(self.surfaced_height), self.rise_time, ease="out_quad")
                ctx.audio.play(ctx.config(Sounds).kraken_rise, at=self.at_height(0))
                ctx.vfx.play(Assets.vfx.big_splash, at=self.at_height(0.5))
        elif self.dive is Dive.SURFACING:
            self.enter(ctx, Dive.LASHING, self.lash_time)
            ctx.vfx.play(Assets.vfx.big_splash, at=self.entity.transform.position + Vec3(0, 0.5, 0), count=28)
        else:
            self.enter(ctx, Dive.HIDDEN, self.rest_time + random.uniform(0, 4))

    def keep_lashing(self, ctx):
        if ctx.time.now >= self.next_lash:
            self.next_lash = ctx.time.now + self.lash_every
            damage = self.damage * current_leg(ctx).enemy_damage_scale
            for ship in self.ships_within(ctx, self.reach):
                ship.get(Health).damage(damage, source=self.entity)
        if ctx.time.now >= self.phase_ends:
            self.enter(ctx, Dive.SUBMERGING, self.sink_time)
            self.entity.transform.move_to(self.at_height(self.hidden_depth), self.sink_time, ease="in_quad")

    def enter(self, ctx, dive, seconds):
        self.dive = dive
        self.phase_ends = ctx.time.now + seconds

    def at_height(self, y):
        return self.entity.transform.position.with_y(y)

    def ships_within(self, ctx, radius):
        return ctx.world.query(tagged=CrewShip).near(self.at_height(0), radius).to_list()
