from parallax import AudioSource, Behavior, Vec3, behavior, clamp, param
from parallax.physics import Rigidbody
from parallax.vehicles import Vehicle

from game.actions import FlightControls
from game.components import Cockpit


@behavior("flight_control", requires=[Vehicle, Rigidbody, Cockpit, AudioSource])
class FlightControl(Behavior):
    """The cockpit. The vehicles plugin flies the plane; this turns
    the pilot's controls into its inputs.

    The throttle is a lever that moves at a fixed rate and, on the ground, past idle into
    reverse pitch to brake. With the stick centred an auto-trim feeds nose input against
    the climb or sink rate so the plane levels off instead of porpoising. The rudder also
    swings the flight path in the air (an openly declared arcade assist), so A/D turns the
    plane without banking it. Flaps step down a notch per press and retract from full;
    the brakes are the airbrake in the air and the wheel brakes on the ground. The
    engine loop runs while someone is aboard."""

    throttle_rate: float = param(0.8, unit="1/s")
    reverse_floor: float = param(-0.5, min=-1, max=0)
    trim_gain: float = param(0.15, doc="Nose input per m/s of vertical speed.")
    trim_limit: float = param(0.5, min=0, max=1)
    flat_turn_rate: float = param(28, unit="deg/s", doc="0 = an honest skid.")
    flap_notch: float = param(0.5, min=0.1, max=1)

    def update(self, ctx, dt):
        vehicle = self.entity.get(Vehicle)
        cockpit = self.entity.get(Cockpit)
        self.entity.get(AudioSource).playing = vehicle.driver is not None
        if vehicle.driver is None:
            cockpit.throttle = 0
            return

        body = self.entity.get(Rigidbody)
        power = ctx.input.axis(FlightControls.power)
        stick = ctx.input.axis(FlightControls.stick)
        if ctx.input.pressed(FlightControls.flaps):
            cockpit.flaps = 0.0 if cockpit.flaps >= 1 else min(1.0, cockpit.flaps + self.flap_notch)
        floor = self.reverse_floor if vehicle.grounded else 0
        cockpit.throttle = clamp(cockpit.throttle + power.y * self.throttle_rate * dt, floor, 1)

        braking = ctx.input.held(FlightControls.brakes)
        trim = clamp(-self.trim_gain * body.velocity.y, -self.trim_limit, self.trim_limit)
        vehicle.fly(throttle=cockpit.throttle, pitch=stick.y if stick.y != 0 else trim, roll=stick.x,
                    yaw=power.x, flaps=cockpit.flaps, airbrake=braking and vehicle.airborne,
                    brake=1.0 if braking and vehicle.grounded else 0.0)
        if vehicle.airborne and power.x:
            self.swing_flight_path(body, power.x, dt)

    def swing_flight_path(self, body, rudder, dt):
        """Turn the horizontal velocity with the nose; climb and sink are untouched."""
        velocity = body.velocity
        turned = velocity.xz().rotated(-rudder * self.flat_turn_rate * dt)  # right rudder: clockwise from above
        body.velocity = Vec3(turned.x, velocity.y, turned.y)
