from parallax import Behavior, HeatHaze, behavior
from parallax.physics import Rigidbody
from parallax.vehicles import Vehicle

from game.actions import DriveControls
from game.components import Nitro, Racer
from game.config import RaceRules
from game.rules import is_racing


@behavior("nitro_boost", requires=[Nitro], when=is_racing)
class NitroBoost(Behavior):
    """Earn nitro on the edge, spend it on the straight.

    The tank fills while the car drifts or sits in the slipstream of a rival ahead,
    and empties while the nitro button is held, pushing the car forward. Once lit it
    burns to empty, but it only lights above a minimum charge."""

    def fixed_update(self, ctx, dt):
        car = self.entity.parent
        nitro = self.entity.get(Nitro)
        tuning = ctx.config(RaceRules)
        vehicle = car.get(Vehicle)
        speed = abs(vehicle.speed)
        gain = 0.0
        if vehicle.drifting and speed > tuning.nitro_drift_min_speed:
            gain += tuning.nitro_drift_gain
        if speed > tuning.nitro_slipstream_min_speed and self.in_slipstream(ctx, car, tuning):
            gain += tuning.nitro_slipstream_gain
        nitro.charge = min(nitro.capacity, nitro.charge + gain * nitro.gain_scale * dt)

        was_active = nitro.active
        nitro.active = (ctx.input.held(DriveControls.nitro) and nitro.charge > 0
                        and (was_active or nitro.charge >= tuning.nitro_min_charge))
        if not nitro.active:
            return
        if not was_active:
            ctx.camera.main.shake(0.26, 0.24)
            self.entity.get(HeatHaze).pulse()  # the template's activation shockwave (addShockwave, 320 ms)
        nitro.charge = max(0.0, nitro.charge - tuning.nitro_drain * dt)
        car.get(Rigidbody).force(car.transform.forward.flat().normalized() * tuning.nitro_force)

    def in_slipstream(self, ctx, car, tuning):
        """Close behind a rival, and pointed at it."""
        here = car.transform.position
        forward = car.transform.forward.flat().normalized()
        for rival, _ in ctx.world.query(Racer).near(here, tuning.nitro_slipstream_range):
            offset = (rival.transform.position - here).flat()
            if rival != car and offset.length() > 3 and forward.dot(offset.normalized()) >= tuning.nitro_slipstream_alignment:
                return True
        return False
