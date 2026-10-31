from parallax import Behavior, behavior, clamp, param
from parallax.vehicles import Vehicle

from game.actions import Helm
from game.components import Rig
from game.config import VoyageRules
from game.rules import sailing, squall_raging


@behavior("helm", requires=[Vehicle, Rig], when=sailing)
class HelmBehavior(Behavior):
    """Sails a captain's ship. Runs on the server; `ctx.input` is the owning captain's.

    The sail is hoisted and furled at a fixed rate and stays where it's left. Hoisted
    canvas always drives the ship forward (arcade sailing — no tacking), a squall reefs
    it, and the anchor holds the ship in place until it's weighed."""

    hoist_rate: float = param(0.4, unit="1/s")

    def update(self, ctx, dt):
        rig = self.entity.get(Rig)
        vehicle = self.entity.get(Vehicle)
        rig.sail = clamp(rig.sail + ctx.input.value(Helm.sail) * self.hoist_rate * dt, 0, 1)
        if ctx.input.pressed(Helm.anchor):
            rig.anchored = not rig.anchored
        if rig.anchored:
            vehicle.drive(brake=1)
            return
        reefed = ctx.config(VoyageRules).storm_sail_scale if squall_raging(ctx) else 1
        vehicle.drive(throttle=rig.sail * reefed, steer=ctx.input.value(Helm.rudder))
