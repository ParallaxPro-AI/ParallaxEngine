"""Driving, crash damage and the engine note."""

from parallax import Animator, AudioSource, Behavior, Collided, Particles, behavior, on, param, vec3
from parallax.characters import Character
from parallax.combat import Health
from parallax.vehicles import Vehicle
from project import Assets

from features.driving.actions import DrivingControls
from features.driving.components import CarCondition
from features.driving.config import DrivingRules
from features.driving.events import VehicleWrecked
from features.driving.queries import nearest_free_car
from features.on_foot.feature import OnFootControls


@behavior("driver", requires=[Character, Health, Animator])
class Driver(Behavior):
    """Enter gets into the nearest free, drivable car and sits in its driver's seat (the car's
    first Seat child, in the seated pose); behind the wheel the driving controls drive it; Exit
    steps out beside the driver's door once the car has almost stopped (the vehicle picks the
    first clear spot: that side, else the other, behind, the roof)."""

    def update(self, ctx, dt):
        body = self.entity.get(Character)
        car = body.vehicle
        self.entity.get(Animator).set_param("driving", car is not None)
        if self.entity.get(Health).dead:
            return
        if car is None:
            free = nearest_free_car(ctx, self.entity) if ctx.input.pressed(OnFootControls.enter) else None
            if free is not None:
                free.get(Vehicle).enter(self.entity)
            return
        rules = ctx.config(DrivingRules)
        vehicle = car.get(Vehicle)
        if ctx.input.pressed(DrivingControls.exit) and abs(vehicle.speed) < rules.exit_speed:
            vehicle.exit(self.entity)
            return
        vehicle.drive(
            throttle=ctx.input.value(DrivingControls.throttle),
            steer=ctx.input.value(DrivingControls.steer),
            brake=1 if ctx.input.held(DrivingControls.brake) else 0,
            handbrake=ctx.input.held(DrivingControls.handbrake),
        )


@behavior("car_damage", requires=[Vehicle, CarCondition, Particles], tick="significance")
class CarDamage(Behavior):
    """Crashes wear the car down. Grip and top speed fall with damage (as stat modifiers, so the prefab's
    handling stays the base); past `smoke_at` it smokes; at 1 it is wrecked and will not drive. Repairing
    is setting `damage` back to 0 — the rest follows."""

    smoke_at: float = param(0.6, min=0, max=1)
    grip_loss: float = param(0.5, min=0, max=1, doc="Fraction of grip lost at full damage.")
    speed_loss: float = param(0.4, min=0, max=1, doc="Fraction of top speed lost just short of a wreck.")

    @on(Collided)
    def crash(self, ctx, event: Collided):
        condition = self.entity.get(CarCondition)
        if condition.damage >= 1 or event.impulse < condition.crash_impulse:
            return
        condition.damage = min(1.0, condition.damage + (event.impulse - condition.crash_impulse) * condition.fragility)
        if condition.damage >= 1:
            ctx.vfx.play(Assets.vfx.car_explosion, at=self.entity.transform.position + vec3(0, 0.4, 0))
            ctx.emit(VehicleWrecked(vehicle=self.entity, driver=self.entity.get(Vehicle).driver))

    def update(self, ctx, dt):
        damage = self.entity.get(CarCondition).damage
        speed_left = 0 if damage >= 1 else 1 - self.speed_loss * damage
        self.entity.modify(Vehicle, "grip", multiply=1 - self.grip_loss * damage, key="crash_grip")
        self.entity.modify(Vehicle, "max_speed", multiply=speed_left, key="crash_speed")
        self.entity.get(Particles).emitting = damage >= self.smoke_at


@behavior("engine_note", requires=[Vehicle, AudioSource])
class EngineNote(Behavior):
    """The engine loop plays while someone is at the wheel, pitched by speed."""

    idle_pitch: float = param(0.8)
    pitch_range: float = param(0.7)

    def update(self, ctx, dt):
        vehicle = self.entity.get(Vehicle)
        engine = self.entity.get(AudioSource)
        engine.playing = vehicle.driver is not None
        engine.pitch = self.idle_pitch + self.pitch_range * min(1.0, abs(vehicle.speed) / max(1.0, vehicle.max_speed))
