"""Ambient model motion (library piece `model_ambient`).

Drives the joints a model declares, from data on the prefab:

    "behaviors": {"model_ambient": {"motions": [
        {"joint": "fan",   "mode": "spin",      "period": 1.2},
        {"joint": "hull",  "mode": "oscillate", "period": 4, "low": -3, "high": 3},
        {"joint": "door",  "mode": "proximity", "near": "player", "radius": 3}]}}

Values are in the joint's own units (hinge degrees, slider meters): spin turns a hinge a
full turn every `period` seconds (free-turning hinges — fans, rotors, beacons); oscillate
eases between `low` and `high`, the joint's own limits (`Model.limits`) when they're left
out; proximity opens the joint (`Model.open`, to its upper limit
over its authored duration) while an entity with the `near` tag is within `radius`, and
closes it when none is. `desync` gives each copy its own phase so a row of fans doesn't
turn in lockstep (from the seeded `random`, so replays match).

A motion the model should ALWAYS have belongs in the model itself; this is for motion a
game adds to a model that doesn't declare it."""

import math
import random

from parallax import Behavior, Model, Tag, behavior, field, param, record, state


@record
class AmbientMotion:
    joint: str
    mode: str = field("oscillate", choices=["spin", "oscillate", "proximity"])
    period: float = field(3, min=0.05, unit="s")
    low: float | None = field(None, doc="oscillate: one end, in the joint's units; None = its lower limit.")
    high: float | None = field(None, doc="oscillate: the other end; None = its upper limit.")
    phase: float = field(0, min=0, max=1, doc="Fraction of a cycle to start at.")
    near: Tag | None = field(None, doc="proximity: entities with this tag open it.")
    radius: float = field(3, min=0, unit="m")


@behavior("model_ambient", requires=[Model])
class ModelAmbient(Behavior):
    """Spins, oscillates or opens this entity's model joints."""

    motions: list[AmbientMotion] = param([])
    desync: bool = param(True, doc="Random starting phase per entity.")
    offset: float = state(0.0)
    opened: list[bool] = state([])

    def start(self, ctx):
        self.offset = random.random() if self.desync else 0.0
        self.opened = [False for _ in self.motions]

    def update(self, ctx, dt):
        model = self.entity.get(Model)
        here = self.entity.transform.position
        for i, m in enumerate(self.motions):
            cycle = ctx.time.now / m.period + m.phase + self.offset
            if m.mode == "spin":
                model.pose(m.joint, (cycle % 1.0) * 360.0)
            elif m.mode == "oscillate":
                low, high = self.range(model, m)
                model.pose(m.joint, low + (high - low) * (0.5 - 0.5 * math.cos(cycle * 2 * math.pi)))
            elif m.near is not None:
                close_by = ctx.world.query(tagged=m.near).near(here, m.radius).count() > 0
                if close_by != self.opened[i]:
                    self.opened[i] = close_by
                    if close_by:
                        model.open(m.joint)
                    else:
                        model.close(m.joint)

    def range(self, model, m):
        """An oscillation's ends: as given, else the joint's limits (0..360 when it turns freely)."""
        limits = model.limits(m.joint) or (0.0, 360.0)
        low = limits[0] if m.low is None else m.low
        high = limits[1] if m.high is None else m.high
        return low, high
