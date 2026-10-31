import math

from parallax import Behavior, Model, Settings, behavior, param, state
from parallax.combat import Health

from game.components import Husk

BASE_SCALE = 0.82
"""Every garden character stands at 82 % of its model's size (the template's base)."""
POP_SECONDS = 0.32
RECOIL_SECONDS = 0.28


@behavior("garden_character", requires=[Model, Health])
class GardenCharacter(Behavior):
    """Brings a plant or husk code model to life through its joints: a sway, a husk's
    walking legs (still while it chews), a plant's recoil when it shoots or is bitten,
    and a pop when it's placed. Reduced motion (Settings) holds every pose still.

    The models' joints: `sway` (hinge, ±5°) on all, `leg_l` / `leg_r` (hinges, ±28°) on
    husks, `recoil` (slider, 0–0.16 m) on plants.
    """

    enemy: bool = param(False, doc="A husk: faster sway and walking legs.")

    age: float = state(0.0)
    last_health: float = state(-1.0)
    offset: float = state(0.0)

    def start(self, ctx):
        self.age = 0.0
        self.last_health = -1.0
        spot = self.entity.transform.position
        self.offset = spot.x * 1.7 + spot.z * 3.1  # neighbours don't sway in step
        self.entity.transform.scale = BASE_SCALE * 0.65

    def update(self, ctx, dt):
        if ctx.get(Settings).reduced_motion:
            self.entity.transform.scale = BASE_SCALE
            return
        self.age += dt
        model = self.entity.get(Model)
        health = self.entity.get(Health).current
        if 0 <= health < self.last_health:
            self.recoil()
        self.last_health = health

        phase = self.age * (8 if self.enemy else 2.4) + self.offset
        model.pose("sway", math.sin(phase) * (4.5 if self.enemy else 2.5))
        if self.enemy:
            stride = 1.68 if self.entity.get(Husk).chewing else 25.2
            model.pose("leg_l", math.sin(phase) * stride)
            model.pose("leg_r", -math.sin(phase) * stride)

        # A quick overshoot makes placing a seed feel physical.
        if self.age < POP_SECONDS:
            t = self.age / POP_SECONDS
            self.entity.transform.scale = (0.65 + 0.35 * t + math.sin(t * math.pi) * 0.25) * BASE_SCALE
        elif self.age - dt < POP_SECONDS:
            self.entity.transform.scale = BASE_SCALE

    def recoil(self):
        """Kick a plant's body back and ease it home (shooting, being bitten)."""
        if self.enemy:
            return
        model = self.entity.get(Model)
        model.pose("recoil", 0.16)
        model.pose("recoil", 0, seconds=RECOIL_SECONDS, ease="out_quad")
