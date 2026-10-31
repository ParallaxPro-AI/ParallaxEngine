from parallax import Behavior, behavior, clamp, inverse_lerp, param
from parallax.vehicles import Vehicle

from game.actions import DriveControls
from game.rules import is_racing


@behavior("player_driver", when=is_racing)
class PlayerDriver(Behavior):
    """Turns the drive controls into pedals and wheel for the car this driver sits in.

    The opposite direction is the brake while rolling (a one-pedal automatic), and full
    gas is eased off while steering at speed, so a keyboard's all-or-nothing throttle
    behaves like a driver's partial lift instead of ploughing on into understeer."""

    reverse_brake_speed: float = param(1.5, unit="m/s",
                                       doc="Above this, the opposite direction brakes instead of reversing.")
    lift_from_speed: float = param(10, unit="m/s")
    lift_full_at_speed: float = param(30, unit="m/s")
    max_lift: float = param(0.5, min=0, max=1, doc="Throttle shed at full lock and full speed.")

    def update(self, ctx, dt):
        vehicle = self.entity.parent.get(Vehicle)
        steer = ctx.input.value(DriveControls.steer)
        throttle = ctx.input.value(DriveControls.throttle)
        brake = 0.0
        speed = vehicle.speed
        if throttle * speed < 0 and abs(speed) > self.reverse_brake_speed:
            throttle, brake = 0.0, abs(throttle)
        if throttle > 0:
            at_speed = clamp(inverse_lerp(self.lift_from_speed, self.lift_full_at_speed, speed), 0, 1)
            throttle *= 1 - self.max_lift * abs(steer) * at_speed

        vehicle.drive(throttle=throttle, steer=steer, brake=brake,
                      handbrake=ctx.input.held(DriveControls.drift))
