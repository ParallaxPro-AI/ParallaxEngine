import random

from parallax import Behavior, Quat, Vec2, Vec3, behavior, clamp, on, param, state, vec2, vec3
from parallax.physics import Rigidbody
from project import Placed

from game.actions import Controls
from game.components import Phase, Throw
from game.config import Release
from game.darts import draught_push, face_offset, launch_velocity, on_face, predict_path, scatter
from game.events import DartLanded, DartThrown, LegStarted
from game.resources import Air, Match, Stage


def throwing(ctx) -> bool:
    return ctx.get(Match).stage is Stage.THROWING


@behavior("dart_throw", requires=[Throw, Rigidbody], when=throwing)
class DartThrow(Behavior):
    """The player's arm and the dart's flight, while a leg is being thrown.

    At the oche: aim walks the reticle over the board, holding throw runs the
    power meter up and back down, and releasing launches the dart straight at the
    reticle (plus scatter for a release outside the clean band). In flight it is
    a real rigidbody: gravity drops it, and the hall's draught pushes it sideways
    every step. Where it crosses the board plane it sticks for a beat, and the
    landing is reported as `DartLanded`. Between legs it stays in the board until
    the next `LegStarted` puts it back in the hand."""

    aim_speed_x: float = param(0.715, unit="m/s", doc="Reticle speed across at full stick.")
    aim_speed_y: float = param(0.609, unit="m/s", doc="Reticle speed up and down at full stick.")
    aim_limit: float = param(1.11, unit="m", doc="Furthest the reticle goes from the bull.")
    charge_seconds: float = param(1.05, unit="s", doc="Meter time from empty to full.")
    base_speed: float = param(16.49, unit="m/s")
    speed_range: float = param(10.99, unit="m/s", doc="Extra launch speed at full power.")
    scatter_max: float = param(0.148, unit="m")
    draught_accel: float = param(3.4, doc="Sideways m/s² per m/s of draught.")
    plane_gap: float = param(0.12, unit="m", doc="Scoring plane, in front of the board face.")
    floor_y: float = param(0.12, unit="m")
    max_flight_seconds: float = param(4.0, unit="s")
    stick_seconds: float = param(0.9, unit="s", doc="How long a dart stays in the board to be read.")
    preview_power: float = param(0.62, min=0, max=1, doc="Power the aim line assumes before charging.")
    preview_points: int = param(16, min=2)
    preview_step: float = param(0.02, unit="s")

    oche: Vec3 = state(Vec3.ZERO)
    rising: bool = state(True)
    clean: bool = state(False)
    flight_time: float = state(0.0)
    stuck_for: float = state(0.0)

    def start(self, ctx):
        self.oche = self.entity.transform.position
        self.hold()

    @on(LegStarted)
    def new_leg(self, ctx, event):
        self.entity.get(Throw).aim = Vec2.ZERO
        self.hold()

    def update(self, ctx, dt):
        throw = self.entity.get(Throw)
        if throw.phase is Phase.STUCK:
            self.stuck_for -= dt
            if self.stuck_for <= 0:
                self.hold()
        elif throw.phase is not Phase.FLYING:
            self.walk_reticle(ctx, throw, dt)
            self.run_meter(ctx, throw, dt)

    def fixed_update(self, ctx, dt):
        throw = self.entity.get(Throw)
        if throw.phase is not Phase.FLYING:
            return
        body = self.entity.get(Rigidbody)
        air = ctx.get(Air)
        body.force(draught_push(air.bearing, air.speed, self.draught_accel) * body.mass)
        self.face(body.velocity)
        self.flight_time += dt

        position = self.entity.transform.position
        board = self.board(ctx)
        plane = board.z + self.plane_gap
        if position.z <= plane:
            self.stick(ctx, position.with_z(plane), face_offset(position - board))
        elif position.y <= self.floor_y or self.flight_time >= self.max_flight_seconds:
            ctx.emit(DartLanded(at=position, clean=self.clean))
            self.hold()

    # ── at the oche ──────────────────────────────────────────────────────────

    def walk_reticle(self, ctx, throw: Throw, dt: float):
        stick = ctx.input.axis(Controls.aim)
        aim = throw.aim + vec2(stick.x * self.aim_speed_x, stick.y * self.aim_speed_y) * dt
        throw.aim = vec2(clamp(aim.x, -self.aim_limit, self.aim_limit), clamp(aim.y, -self.aim_limit, self.aim_limit))
        target = self.board(ctx) + on_face(throw.aim)
        power = throw.power if throw.phase is Phase.CHARGING else self.preview_power
        velocity = launch_velocity(self.oche, target, power, self.base_speed, self.speed_range)
        air = ctx.get(Air)
        throw.path = predict_path(
            self.oche,
            velocity,
            draught_push(air.bearing, air.speed, self.draught_accel) + vec3(0, ctx.physics.gravity, 0),
            stop_z=target.z + self.plane_gap,
            floor_y=self.floor_y,
            points=self.preview_points,
            step=self.preview_step,
        )
        self.face(target - self.oche)

    def run_meter(self, ctx, throw: Throw, dt: float):
        if ctx.input.pressed(Controls.throw):
            throw.phase = Phase.CHARGING
            throw.power = 0.0
            self.rising = True
        elif throw.phase is Phase.CHARGING and ctx.input.held(Controls.throw):
            throw.power = clamp(throw.power + dt / self.charge_seconds * (1 if self.rising else -1), 0, 1)
            if throw.power >= 1:
                self.rising = False
            elif throw.power <= 0:
                self.rising = True
        elif throw.phase is Phase.CHARGING:
            self.launch(ctx, throw)

    def launch(self, ctx, throw: Throw):
        release = ctx.config(Release)
        stray = scatter(throw.power, release.clean_from, release.clean_to, self.scatter_max)
        aim = throw.aim + Vec2.from_angle(random.uniform(0, 360), random.uniform(0, stray))
        target = self.board(ctx) + on_face(aim)
        body = self.entity.get(Rigidbody)
        body.kind = "dynamic"
        body.velocity = launch_velocity(self.oche, target, throw.power, self.base_speed, self.speed_range)
        self.clean = stray == 0
        self.flight_time = 0.0
        throw.phase = Phase.FLYING
        throw.path = []
        ctx.emit(DartThrown(power=throw.power, clean=self.clean))

    # ── landing and the dart in hand ─────────────────────────────────────────

    def stick(self, ctx, at: Vec3, offset: Vec2):
        body = self.entity.get(Rigidbody)
        body.kind = "kinematic"
        body.velocity = Vec3.ZERO
        body.teleport(at)
        self.entity.get(Throw).phase = Phase.STUCK
        self.stuck_for = self.stick_seconds
        ctx.emit(DartLanded(at=at, offset=offset, clean=self.clean))

    def hold(self):
        """Back in the player's hand at the oche, pinned against gravity."""
        body = self.entity.get(Rigidbody)
        body.kind = "kinematic"
        body.velocity = Vec3.ZERO
        body.teleport(self.oche)
        throw = self.entity.get(Throw)
        throw.phase = Phase.AIMING
        throw.power = 0.0

    def face(self, direction: Vec3):
        """Nose-first: the dart model points along its local +z."""
        self.entity.transform.rotation = Quat.look_rotation(direction)

    def board(self, ctx) -> Vec3:
        return ctx.world.placed(Placed.board).transform.position
