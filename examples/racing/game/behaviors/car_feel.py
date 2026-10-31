from parallax import Behavior, Vec3, behavior, state
from parallax.vehicles import Vehicle
from project import Assets

from game.components import Nitro, Racer
from game.config import RaceRules
from game.rules import is_racing, racing_line
from game.track import line_offset

REAR_HALF_TRACK = 0.59
REAR_AXLE_BACK = 0.66


@behavior("car_feel", requires=[Nitro], when=is_racing)
class CarFeel(Behavior):
    """The car under you, for the eyes and the hands.

    Tyre smoke from both rear tyres while sliding (denser, and sparking, as the slide
    fills the nitro tank), dust while off the track, sparks from the exhausts on nitro;
    and on a gamepad or phone a jolt on a hit (a sudden loss of speed no brake can
    make), a light buzz on the kerb and a rougher one on the verge. Two cues on purpose:
    smoke says "sliding, earning nitro"; dust says "wrong surface, losing time"."""

    puff_in: float = state(0.0, doc="Seconds to the next smoke/dust puff.")
    previous_speed: float = state(0.0)
    hit_cool: float = state(0.0)
    verge_cool: float = state(0.0)

    def fixed_update(self, ctx, dt):
        car = self.entity.parent
        tuning = ctx.config(RaceRules)
        vehicle = car.get(Vehicle)
        speed = abs(vehicle.speed)
        offset = line_offset(racing_line(ctx), car.transform.position, car.get(Racer))
        self.puffs(ctx, car, vehicle, speed, offset, tuning, dt)
        self.rumble(ctx, speed, offset, tuning, dt)

    def puffs(self, ctx, car, vehicle, speed, offset, tuning, dt):
        nitro = self.entity.get(Nitro)
        drifting = vehicle.drifting and speed > 8
        off_track = offset > tuning.verge_from and speed > 5
        if not (drifting or off_track or nitro.active):
            self.puff_in = 0.0
            return
        self.puff_in -= dt
        if self.puff_in > 0:
            return
        self.puff_in = tuning.smoke_every
        tf = car.transform
        forward, right = tf.forward.flat().normalized(), tf.right.flat().normalized()
        charge = nitro.charge / nitro.capacity if nitro.capacity > 0 else 0.0
        for side in (-1, 1):
            patch = tf.position - forward * REAR_AXLE_BACK + right * (REAR_HALF_TRACK * side) + Vec3(0, -0.18, 0)
            if drifting:
                ctx.vfx.play(Assets.vfx.tire_smoke, at=patch, scale=1 + charge)
                if charge > tuning.smoke_sparks_from:
                    ctx.vfx.play(Assets.vfx.nitro_sparks, at=patch, scale=0.6 + charge)
            if off_track:
                ctx.vfx.play(Assets.vfx.verge_dust, at=patch)
            if nitro.active:
                exhaust = tf.position - forward * 0.95 + right * (0.26 * side) + Vec3(0, 0.78, 0)
                ctx.vfx.play(Assets.vfx.nitro_sparks, at=exhaust, direction=-forward)

    def rumble(self, ctx, speed, offset, tuning, dt):
        self.hit_cool = max(0.0, self.hit_cool - dt)
        self.verge_cool = max(0.0, self.verge_cool - dt)
        drop = self.previous_speed - speed
        self.previous_speed = speed
        if (dt > 0 and speed + drop > 6 and drop > tuning.hit_speed_drop
                and drop / dt > tuning.hit_deceleration and self.hit_cool <= 0):
            hit = min(1.0, 0.35 + drop / 14.0)
            ctx.input.rumble(hit, 0.18 + 0.24 * hit)
            self.hit_cool = tuning.hit_cooldown
        if speed <= 5 or self.verge_cool > 0:
            return
        if offset > tuning.verge_from:
            ctx.input.rumble(0.5, 0.17)
            self.verge_cool = 0.15
        elif offset > tuning.road_half_width:
            ctx.input.rumble(0.45, 0.15)
            self.verge_cool = 0.12
