from parallax import Behavior, behavior, on, param, vec3
from parallax.characters import Character
from parallax.combat import Damaged, Health
from project import Content, Text

from game.audio import Sounds
from features.inventory.feature import selected, spend_selected
from features.survival.components import Vitals
from features.survival.home import respawn_point
from features.survival.resources import Run
from game.actions import Controls
from game.config import Rules


@behavior("survival", requires=[Vitals, Health, Character])
class Survival(Behavior):
    """Hunger drains and food refills it. An empty stomach hurts and a fed one
    heals; under water the air runs out and then you drown. Falling out of the
    world brings you home."""

    hunger_per_second: float = param(0.1)
    starve_damage: float = param(1.0, unit="hp/s")
    regen: float = param(0.75, unit="hp/s")
    regen_above_hunger: float = param(30)
    eye_height: float = param(1.55, unit="m")
    air_refill: float = param(3, doc="Seconds of air regained per second above water.")
    drown_damage: float = param(5, unit="hp/s")

    def update(self, ctx, dt):
        vitals = self.entity.get(Vitals)
        health = self.entity.get(Health)
        vitals.hunger = max(0.0, vitals.hunger - self.hunger_per_second * dt)
        if vitals.hunger > self.regen_above_hunger:
            health.heal(self.regen * dt)

        head = ctx.voxels.cell_at(self.entity.transform.position + vec3(0, self.eye_height, 0))
        if ctx.voxels.get(head) == Content.block.water:
            vitals.air = max(0.0, vitals.air - dt)
        else:
            vitals.air = min(vitals.max_air, vitals.air + self.air_refill * dt)

        health.drain(self.starve_damage if vitals.hunger == 0 else 0, key="starving")
        health.drain(self.drown_damage if vitals.air == 0 else 0, key="drowning")

        if ctx.input.pressed(Controls.eat):
            self._eat(ctx)
        if self.entity.transform.position.y < ctx.config(Rules).void_y:
            self.entity.get(Character).teleport(respawn_point(ctx, ctx.get(Run).home))
            ctx.ui.toast(Text.returned_to_safety)

    def _eat(self, ctx):
        food = selected(self.entity).item
        if food is None or food.data.hunger <= 0:
            ctx.ui.toast(Text.select_food)
            return
        spend_selected(self.entity)
        vitals = self.entity.get(Vitals)
        vitals.hunger = min(vitals.max_hunger, vitals.hunger + food.data.hunger)
        if food.data.heal >= 0:
            self.entity.get(Health).heal(food.data.heal)
        else:
            self.entity.get(Health).damage(-food.data.heal)
        ctx.ui.toast(ctx.text(Text.ate, item=ctx.text(food.data.name)))

    @on(Damaged, where=lambda event: event.source is not None)
    def hurt(self, ctx, event: Damaged):
        """Only blows shake the camera; starving, drowning and bad food have no source."""
        ctx.camera.main.shake(0.18, 0.22)
        ctx.audio.play(ctx.config(Sounds).hurt, volume=0.4)
