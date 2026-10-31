import math

from parallax import Behavior, Model, behavior, param, state, vec3
from parallax.combat import Health
from parallax.grid import GridCell
from project import Assets, Text

from game.audio import Sounds, play
from game.components import Husk, Planted
from game.config import GardenRules
from game.events import HuskReachedHouse
from game.notes import announce


@behavior("husk_walker", requires=[Husk, Health])
class HuskWalker(Behavior):
    """Marches down its lane toward the house and eats the first plant in its way.

    Every tier runs this; speed and bite come from the tier's HuskDef, and a chill
    slows it (a modifier on `Husk.speed`).
    Sprinters (`vaults`) hop the first plant they meet. Armored tiers (scrapmask,
    ironhelm) lose the model's `armor` part below half health. `Husk.chewing` tells the
    garden_character joint animation to stop the legs while it bites.
    """

    reach: float = param(0.65, unit="m", doc="How close a plant must be to be bitten.")
    vaults: bool = param(False)
    armored: bool = param(False, doc="Hide the model's `armor` part (with a clank) below half health.")
    leap_distance: float = param(1.5, unit="m")
    leap_height: float = param(0.7, unit="m")
    leap_seconds: float = param(0.5, unit="s")

    bite_ready_at: float = state(0.0)
    leap_started_at: float = state(-1.0)
    leap_from_x: float = state(0.0)
    armor_lost: bool = state(False)

    def update(self, ctx, dt):
        if self.armored and not self.armor_lost:
            health = self.entity.get(Health)
            if health.current < health.max * 0.5:
                self.armor_lost = True
                self.entity.get(Model).parts = {"armor": False}
                play(ctx, ctx.config(Sounds).dig_up)
        if self.leap_started_at >= 0:
            self.leap(ctx)
            return
        plant = self.plant_ahead(ctx)
        husk = self.entity.get(Husk)
        husk.chewing = plant is not None and (husk.vaulted or not self.vaults)
        if plant is None:
            self.march(ctx, dt)
        elif self.vaults and not husk.vaulted:
            husk.vaulted = True
            self.leap_started_at = ctx.time.now
            self.leap_from_x = self.entity.transform.position.x
            ctx.vfx.play(Assets.vfx.dust, at=self.entity.transform.position.with_y(0.3))
            announce(ctx, ctx.text(Text.notice_runner_hopped))
        elif ctx.time.now >= self.bite_ready_at:
            self.bite(ctx, plant)

    def march(self, ctx, dt):
        speed = self.entity.get(Husk).speed
        self.entity.transform.position -= vec3(speed * dt, 0, 0)
        if self.entity.transform.position.x <= ctx.config(GardenRules).house_x:
            ctx.emit(HuskReachedHouse(husk=self.entity))
            self.entity.destroy()

    def bite(self, ctx, plant):
        husk = self.entity.get(Husk).kind.data
        self.bite_ready_at = ctx.time.now + husk.bite_interval
        plant.get(Health).damage(husk.bite_damage, source=self.entity)
        play(ctx, ctx.config(Sounds).husk_munch, at=self.entity)

    def leap(self, ctx):
        t = min(1.0, (ctx.time.now - self.leap_started_at) / self.leap_seconds)
        position = self.entity.transform.position
        self.entity.transform.position = vec3(
            self.leap_from_x - t * self.leap_distance,
            math.sin(t * math.pi) * self.leap_height,
            position.z,
        )
        if t == 1.0:
            self.leap_started_at = -1.0

    def plant_ahead(self, ctx):
        lane = self.entity.get(Husk).lane
        x = self.entity.transform.position.x
        for plant, _, spot in ctx.world.query(Planted, GridCell):
            gap = x - plant.transform.position.x
            if spot.cell.row == lane and -0.05 <= gap < self.reach:
                return plant
        return None
