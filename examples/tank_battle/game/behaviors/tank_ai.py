import random

from parallax import Behavior, PrefabRef, Vec3, behavior, heading_to, on, param, rotate_toward, state, vec3, wrap_angle
from parallax.combat import Damaged, Health
from parallax.nav import NavAgent
from parallax.physics import Rigidbody
from project import Assets, Prefabs

from game.resources import announce
from game.config import Sounds
from game.battlefield import current_battlefield, ground_y
from game.components import EnemyTank, PlayerTank
from game.content import Role

STRAFE = {Role.FLANKER: 1.0, Role.BRAWLER: 0.0, Role.SNIPER: 0.25, Role.BOSS: 0.35}
"""How hard each role circles the player while it fights."""


@behavior("tank_ai", requires=[EnemyTank, Health, NavAgent])
class TankAI(Behavior):
    """An enemy tank. Outside its detection range it advances on the player along the
    navmesh. Inside it, it fights by role:

    flanker  arcs hard around you and closes to knife range
    brawler  drives straight in and holds at its standoff
    sniper   holds long standoff and reverses out if you close in
    boss     a sniper that speeds up and fires salvos as its hull is breached

    Tracks only drive along the hull: it pivots toward where it wants to go and rolls
    forward or back, never sideways. The `NavAgent` only steers (`drives_body=False`).
    The turret (the prefab's "turret" child) traverses on its own."""

    shell: PrefabRef = param(Prefabs.enemy_shell)
    turn_rate: float = param(110, unit="deg/s")
    turret_rate: float = param(150, unit="deg/s")
    advance_speed: float = param(0.85, doc="Speed fraction while closing in unseen.")
    muzzle_height: float = param(1.3, unit="m")

    yaw: float = state(0.0)
    turret_yaw: float = state(0.0)
    ready_at: float = state(0.0)

    def start(self, ctx):
        self.yaw = self.turret_yaw = self.entity.transform.euler.y
        self.ready_at = ctx.time.now + random.uniform(0.5, 1.5)

    def update(self, ctx, dt):
        player = ctx.world.query(tagged=PlayerTank).first()
        if player is None:
            return
        tank = self.entity.get(EnemyTank)
        tier = tank.kind.data
        phase = tier.phases[tank.phase] if tier.phases else None
        here, there = self.entity.transform.position, player.transform.position
        distance = here.distance_to(there)
        speed = tier.speed * (phase.speed_mul if phase else 1)
        if distance > tier.detect:
            self.drive(ctx, self.route_toward(player), speed * self.advance_speed, dt)
            self.aim_turret(self.yaw, dt)
            return
        self.drive(ctx, self.engage_direction(tier, player, distance), speed, dt)
        self.aim_turret(heading_to(here, there), dt)
        interval = tier.fire_interval * (phase.fire_interval_mul if phase else 1)
        if distance <= tier.range and ctx.time.now >= self.ready_at:
            self.ready_at = ctx.time.now + interval
            self.fire(ctx, tier, there, phase)

    def engage_direction(self, tier, player, distance) -> Vec3:
        toward = (player.transform.position - self.entity.transform.position).flat().normalized()
        around = toward.rotated_y(90) * self.entity.get(EnemyTank).flank
        gap = distance - tier.range * tier.standoff
        if gap > 1.5:
            approach = 1.0
        elif gap < -tier.range * tier.standoff * 0.35 and tier.role in (Role.SNIPER, Role.BOSS):
            approach = -1.0
        else:
            approach = 0.0
        if approach > 0 and STRAFE[tier.role] < 0.5:
            return self.route_toward(player)
        return toward * approach + around * STRAFE[tier.role]

    def route_toward(self, player) -> Vec3:
        """Which way the navmesh says to go to reach the player."""
        agent = self.entity.get(NavAgent)
        agent.move_to(player)
        return agent.desired_velocity.flat()

    def drive(self, ctx, direction: Vec3, speed: float, dt: float):
        if direction.length() < 0.001:
            return
        self.yaw = rotate_toward(self.yaw, heading_to(Vec3.ZERO, direction), self.turn_rate * dt)
        forward = Vec3.from_yaw_pitch(self.yaw)
        ahead = forward.dot(direction.normalized())
        roll = speed * (1 if ahead >= 0 else -1) * (0.3 + 0.7 * min(1.0, abs(ahead)))
        self.entity.transform.position = self.on_ground(ctx, self.entity.transform.position + forward * roll * dt)
        self.entity.transform.euler = vec3(0, self.yaw, 0)

    def on_ground(self, ctx, spot: Vec3) -> Vec3:
        """Tracks follow the terrain: the hull rides its tier's height above the ground."""
        return spot.with_y(ground_y(ctx, spot) + self.entity.get(EnemyTank).kind.data.ride)

    def aim_turret(self, target_yaw: float, dt: float):
        self.turret_yaw = rotate_toward(self.turret_yaw, target_yaw, self.turret_rate * dt)
        self.entity.child("turret").transform.local_euler = vec3(0, wrap_angle(self.turret_yaw - self.yaw), 0)

    def fire(self, ctx, tier, target: Vec3, phase):
        muzzle = self.entity.transform.position + vec3(0, self.muzzle_height, 0)
        aim = (target + vec3(0, 1, 0) - muzzle).normalized()
        salvo = phase.salvo if phase else 1
        spread = phase.spread if phase else tier.spread
        damage = tier.damage * current_battlefield(ctx).damage_mul
        for shot in range(salvo):
            fan = (shot - (salvo - 1) / 2) * spread * 1.6
            direction = aim.rotated_y(fan + random.uniform(-spread, spread))
            shell = ctx.world.spawn(self.shell, at=muzzle + direction * 2, params={"enemy_shell": {"damage": damage}})
            shell.get(Rigidbody).velocity = direction * tier.shell_speed
        ctx.vfx.play(Assets.vfx.muzzle_flash, at=muzzle + aim * 2)
        ctx.audio.play(ctx.config(Sounds).cannon, at=self.entity, volume=0.35)

    @on(Damaged)
    def breach(self, ctx, event):
        tank = self.entity.get(EnemyTank)
        phases = tank.kind.data.phases
        fraction = self.entity.get(Health).fraction
        reached = max((i for i, phase in enumerate(phases) if fraction <= phase.at_health), default=0)
        if reached > tank.phase:
            tank.phase = reached
            announce(ctx, ctx.text(phases[reached].name).upper(), "The boss changes tactics!", "danger")
