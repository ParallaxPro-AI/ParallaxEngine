import random

from parallax import Behavior, Vec2, Vec3, behavior, clamp, heading_to, param, state, wrap_angle
from parallax.physics import Rigidbody
from parallax.vehicles import Vehicle
from project import Assets, Prefabs

from game.config import Sounds
from game.components import Cannonball, CrewShip
from game.rules import current_leg, sailing


@behavior("ghost_ship", requires=[Vehicle], when=sailing)
class GhostShip(Behavior):
    """A hull of the dead fleet. It drifts around its anchorage until a captain sails
    within sight, then closes to gun range and fires on that ship every few seconds.
    Each leg's sea hits harder than the last. In port it lies idle."""

    sight: float = param(120, unit="m")
    gun_range: float = param(32, unit="m")
    fire_every: float = param(2.6, unit="s")
    damage: float = param(18)
    muzzle_speed: float = param(40, unit="m/s")
    wander_radius: float = param(40, unit="m")
    wander_every: float = param(6, unit="s")
    wander_sail: float = param(0.5, min=0, max=1)
    full_rudder_at: float = param(45, unit="deg")
    look_ahead: float = param(6, unit="m", doc="Rocks this close ahead send it elsewhere.")

    home: Vec3 = state(Vec3.ZERO)
    waypoint: Vec3 = state(Vec3.ZERO)
    next_wander: float = state(0.0)
    next_shot: float = state(0.0)

    def start(self, ctx):
        self.home = self.waypoint = self.entity.transform.position

    def update(self, ctx, dt):
        vehicle = self.entity.get(Vehicle)
        here = self.entity.transform.position
        prey = ctx.world.query(tagged=CrewShip).near(here, self.sight).nearest(here)
        if prey is None:
            self.wander(ctx, vehicle, here)
            return
        distance = here.distance_to(prey.transform.position)
        throttle = 1.0 if distance > self.gun_range * 0.85 else 0.0
        self.steer_for(vehicle, prey.transform.position, throttle)
        if distance <= self.gun_range and ctx.time.now >= self.next_shot:
            self.next_shot = ctx.time.now + self.fire_every
            self.fire_at(ctx, prey)

    def wander(self, ctx, vehicle, here):
        blocked = ctx.physics.raycast(here + Vec3(0, 0.5, 0), self.entity.transform.forward, self.look_ahead,
                                      ignore=[self.entity])
        if blocked or ctx.time.now >= self.next_wander or here.distance_to(self.waypoint) < 2:
            self.next_wander = ctx.time.now + self.wander_every + random.uniform(0, 4)
            offset = Vec2(random.uniform(-1, 1), random.uniform(-1, 1)) * self.wander_radius
            self.waypoint = self.home + Vec3(offset.x, 0, offset.y)
        self.steer_for(vehicle, self.waypoint, self.wander_sail)

    def steer_for(self, vehicle, point, throttle):
        here = self.entity.transform
        bearing = wrap_angle(heading_to(here.position, point) - here.euler.y)
        vehicle.drive(throttle=throttle, steer=clamp(bearing / self.full_rudder_at, -1, 1))

    def fire_at(self, ctx, prey):
        here = self.entity.transform
        muzzle = here.position + here.up * 1.2
        aim = (prey.transform.position - muzzle).flat().normalized()
        ball = ctx.world.spawn(Prefabs.cannonball, at=muzzle + aim * 3, components=[
            Cannonball(shooter=self.entity, damage=self.damage * current_leg(ctx).enemy_damage_scale),
        ])
        ball.get(Rigidbody).velocity = aim * self.muzzle_speed + Vec3(0, here.forward.y * self.muzzle_speed + 2, 0)
        ctx.audio.play(ctx.config(Sounds).cannon, at=muzzle)
        ctx.vfx.play(Assets.vfx.ghost_broadside_smoke, at=muzzle)
