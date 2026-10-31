import random
from enum import Enum

from parallax import Animator, Behavior, ClipRef, Entity, Model, Vec3, behavior, heading_to, param, state, vec3
from parallax.combat import Health
from parallax.nav import NavAgent
from project import Assets

from game.arena import current_round, player
from game.audio import Sounds, play
from game.components import Bot, CoverSpot
from game.gunplay import fire_bullet, scatter, smoke_between
from game.resources import Mods


class CoverStep(Enum):
    APPROACH = "approach"
    HIDE = "hide"
    PEEK = "peek"


@behavior("bot_brain", requires=[Bot, NavAgent, Health, Animator])
class BotBrain(Behavior):
    """A deathmatch bot, driven by its archetype's numbers.

    Unaware, it wanders its patrol radius and pauses now and then. Once it sees you it
    hunts: it closes to its stop range and circles there instead of standing still,
    and it fires only after a reaction delay and only with line of sight. If you break
    line of sight it goes to where it last saw you (flankers swing wide to one side)
    and gives up after its memory runs out, unless it is relentless. Bots that take
    cover claim a free cover spot, hide, then peek out to shoot.
    """

    eye_height: float = param(1.5, unit="m")
    view_cone: float = param(140, unit="deg")
    miss_angle: float = param(6, unit="deg", doc="How far off a shot that isn't aimed true goes.")
    cover_search: float = param(14, unit="m")
    hide_time: float = param(0.7, unit="s")
    peek_time: float = param(1.8, unit="s")
    flank_offset: float = param(5, unit="m")
    sniper_range: float = param(50, unit="m", doc="Archetypes that shoot this far sound like a sniper rifle.")
    run: ClipRef = param(Assets.clips.run_cycle)
    idle: ClipRef = param(Assets.clips.stand_idle)

    aware: bool = state(False)
    last_seen: Vec3 = state(Vec3.ZERO)
    seen_since: float = state(-1.0)
    lost_at: float = state(0.0)
    strafe: int = state(1)
    strafe_flip_at: float = state(0.0)
    ready_at: float = state(0.0)
    next_wander_at: float = state(0.0)
    cover: Entity | None = state(None)
    cover_step: CoverStep = state(CoverStep.APPROACH)
    cover_until: float = state(0.0)
    cover_retry_at: float = state(0.0)

    def start(self, ctx):
        archetype = self.entity.get(Bot).kind.data
        self.entity.get(NavAgent).speed = archetype.move_speed
        model = self.entity.get(Model)
        model.options = dict(archetype.look)
        if archetype.jacket_tint is not None:
            model.set_color("jacket_torso", archetype.jacket_tint)
        self.entity.transform.scale = archetype.scale

    def end(self, ctx):
        self.leave_cover(ctx)

    def update(self, ctx, dt):
        archetype = self.entity.get(Bot).kind.data
        target = player(ctx)
        eye = self.entity.transform.position + vec3(0, self.eye_height * archetype.scale, 0)
        sees = not target.get(Health).dead and ctx.nav.can_see(
            self.entity, target, fov=self.view_cone,
            distance=archetype.sight_range * (1.4 if self.aware else 1),
        ) and not smoke_between(ctx, eye, target.transform.position + vec3(0, 1.1, 0))
        self.notice(ctx, archetype, target, sees)
        agent = self.entity.get(NavAgent)
        self.entity.get(Animator).play(self.run if agent.moving else self.idle)
        if not self.aware:
            self.wander(ctx, archetype, agent)
            return
        here = self.entity.transform.position
        focus = target.transform.position if sees else self.last_seen
        self.entity.transform.euler = vec3(0, heading_to(here, focus), 0)
        distance = here.distance_to(target.transform.position)
        if self.cover is not None:
            self.hold_cover(ctx, agent, distance)
        elif sees and archetype.takes_cover and distance > 7 and ctx.time.now >= self.cover_retry_at:
            self.take_cover(ctx, target)
        if self.cover is None:
            self.close_in(ctx, archetype, agent, target, sees, distance)
        can_shoot = self.cover is None or self.cover_step is CoverStep.PEEK
        if sees and can_shoot and distance <= archetype.shoot_range and ctx.time.now >= self.ready_at \
                and ctx.time.now - self.seen_since >= archetype.reaction:
            self.ready_at = ctx.time.now + archetype.fire_interval * random.uniform(0.8, 1.2)
            self.shoot(ctx, target)

    def notice(self, ctx, archetype, target, sees):
        if sees:
            self.last_seen = target.transform.position
            self.lost_at = ctx.time.now
            if self.seen_since < 0:
                self.seen_since = ctx.time.now
            self.aware = True
        else:
            self.seen_since = -1.0
            if self.aware and not archetype.relentless and ctx.time.now - self.lost_at > archetype.memory:
                self.aware = False
                self.leave_cover(ctx)

    def wander(self, ctx, archetype, agent):
        if agent.moving or ctx.time.now < self.next_wander_at:
            return
        point = ctx.nav.random_point(self.entity.transform.position, archetype.patrol_radius)
        if point is not None:
            agent.move_to(point)
        self.next_wander_at = ctx.time.now + random.uniform(3.8, 8.4)

    def close_in(self, ctx, archetype, agent, target, sees, distance):
        here = self.entity.transform.position
        if ctx.time.now >= self.strafe_flip_at:
            self.strafe = -self.strafe
            self.strafe_flip_at = ctx.time.now + random.uniform(1.2, 3.0)
        side = (self.last_seen - here).flat().normalized().rotated_y(90) * self.strafe
        if not sees:
            agent.move_to(self.last_seen + side * self.flank_offset if archetype.flanks else self.last_seen)
        elif distance > archetype.stop_range:
            agent.move_to(target)
        else:
            agent.move_to(here + side * 2)

    def take_cover(self, ctx, target):
        here, threat = self.entity.transform.position, target.transform.position
        free = [
            (spot, cover) for spot, cover in ctx.world.query(CoverSpot).near(here, self.cover_search)
            if cover.taken_by is None and spot.transform.position.distance_to(threat) > 6
        ]
        self.cover_retry_at = ctx.time.now + random.uniform(3, 5)
        if not free:
            return
        spot, cover = min(free, key=lambda row: row[0].transform.position.distance_to(here))
        cover.taken_by = self.entity
        self.cover, self.cover_step = spot, CoverStep.APPROACH
        self.entity.get(NavAgent).move_to(spot)

    def hold_cover(self, ctx, agent, distance):
        spot = self.cover.get(CoverSpot)
        if distance < 5 or ctx.time.now - self.lost_at > 2.8:
            self.leave_cover(ctx)
        elif self.cover_step is CoverStep.APPROACH and not agent.moving:
            self.cover_step, self.cover_until = CoverStep.HIDE, ctx.time.now + self.hide_time
        elif self.cover_step is CoverStep.HIDE and ctx.time.now >= self.cover_until:
            self.cover_step, self.cover_until = CoverStep.PEEK, ctx.time.now + self.peek_time
            agent.move_to(spot.peek)
        elif self.cover_step is CoverStep.PEEK and ctx.time.now >= self.cover_until:
            self.leave_cover(ctx)

    def leave_cover(self, ctx):
        if self.cover is not None and self.cover.alive:
            self.cover.get(CoverSpot).taken_by = None
        self.cover = None

    def shoot(self, ctx, target):
        archetype = self.entity.get(Bot).kind.data
        eye = self.entity.transform.position + vec3(0, self.eye_height * archetype.scale, 0)
        aim = (target.transform.position + vec3(0, 1.1, 0) - eye).normalized()
        accuracy = archetype.accuracy * current_round(ctx).accuracy_mul * ctx.get(Mods).bot_accuracy_mul
        fire_bullet(
            ctx, self.entity, eye, aim if random.random() < accuracy else scatter(aim, self.miss_angle),
            damage=archetype.damage, range=archetype.shoot_range * 1.2, tracer=archetype.tracer,
        )
        ctx.vfx.play(Assets.vfx.muzzle_flash, at=eye + aim)
        sounds = ctx.config(Sounds)
        play(ctx, sounds.bot_sniper if archetype.shoot_range >= self.sniper_range else sounds.bot_rifle, at=self.entity)
