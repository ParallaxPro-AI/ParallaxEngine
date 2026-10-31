"""Police units: officers on foot, cruisers and the helicopter."""

import random

from parallax import (
    Behavior, ContentRef, Entity, Light, Model, Vec3, approach, behavior, clamp, heading_to, on, param, state,
    wrap_angle,
)
from parallax.characters import Character
from parallax.combat import Died, Health
from parallax.nav import NavAgent
from parallax.vehicles import Vehicle
from project import Prefabs

from features.on_foot.feature import Player, WeaponDef, WeaponFired
from game.audio import Sounds, play
from features.police.components import Spotter
from features.police.events import PlayerBusted
from features.police.resources import Phase, Wanted, wanted_level
from features.police.tags import Dispatched


def line_of_fire(ctx, shooter: Entity, muzzle: Vec3, player: Entity) -> bool:
    """Nothing solid between the muzzle and the player's chest (lower when he crouches in cover)."""
    chest = player.transform.position + Vec3.UP * (0.6 if player.get(Character).stance == "crouch" else 1.2)
    hit = ctx.physics.raycast(muzzle, (chest - muzzle).normalized(), muzzle.distance_to(chest), ignore=[shooter])
    return hit is None or hit.entity == player


@behavior("police_officer", requires=[NavAgent, Health, Spotter], tick="significance")
class PoliceOfficer(Behavior):
    """Runs the player down. From `armed_from` stars he shoots on sight with his service weapon;
    below that he closes in, and if the player is on foot and hurt, he cuffs them. With the player out
    of sight he searches around the last sighting."""

    weapon: ContentRef[WeaponDef] = param(doc="What the crowd hears him fire.")
    damage: float = param(11, min=0, doc="Per hit on foot; a car's bodywork takes most of it.")
    fire_range: float = param(18, unit="m", doc="Plus 2 m per star.")
    fire_interval: float = param(1.25, unit="s", doc="Shortened 16% per star past the first (to 35% at most).")
    accuracy: float = param(0.62, min=0, max=1, doc="At one star; +0.08 per star, up to 0.95.")
    in_car_factor: float = param(0.35, min=0, max=1, doc="Share of a hit that reaches a driver.")
    armed_from: int = param(2, min=1, max=5)
    arrest_range: float = param(2.6, unit="m")
    arrest_below: float = param(0.5, min=0, max=1, doc="Player health fraction at which he can cuff.")
    cuff_seconds: float = param(1.2, unit="s")
    search_radius: float = param(14, unit="m")
    fire_in: float = state(0.0)
    cuffing: float = state(0.0)

    @on(Died)
    def down(self, ctx, event: Died):
        play(ctx, ctx.config(Sounds).officer_down, at=self.entity)

    def update(self, ctx, dt):
        wanted = ctx.get(Wanted)
        agent = self.entity.get(NavAgent)
        if wanted.phase is Phase.CALM or self.entity.get(Health).dead:
            agent.stop()
            return
        player, health, body = ctx.world.query(Health, Character, tagged=Player).single()
        spotter = self.entity.get(Spotter)
        if wanted.phase is Phase.SEARCH or not ctx.nav.can_see(self.entity, player, fov=spotter.fov, distance=spotter.range):
            self.search(ctx, wanted.last_seen)
            return
        distance = self.entity.transform.position.distance_to(player.transform.position)
        if wanted_level(wanted) >= self.armed_from:
            self.engage(ctx, player, distance, dt)
            return
        agent.move_to(player)
        cornered = distance <= self.arrest_range and body.vehicle is None and health.fraction <= self.arrest_below
        self.cuffing = self.cuffing + dt if cornered else 0.0
        if self.cuffing >= self.cuff_seconds:
            self.cuffing = 0.0
            ctx.emit(PlayerBusted(by=self.entity))

    def engage(self, ctx, player: Entity, distance: float, dt: float):
        agent = self.entity.get(NavAgent)
        stars = wanted_level(ctx.get(Wanted))
        if distance > (self.fire_range + stars * 2) * 0.6:
            agent.move_to(player)
            return
        agent.stop()
        self.entity.transform.euler = self.entity.transform.euler.with_y(heading_to(self.entity.transform.position, player.transform.position))
        self.fire_in -= dt
        if self.fire_in > 0:
            return
        self.fire_in = self.fire_interval * max(0.35, 1.0 - (stars - 1) * 0.16)
        muzzle = self.entity.transform.position + Vec3.UP * 1.4
        if random.random() < min(0.95, self.accuracy + (stars - 1) * 0.08) and line_of_fire(ctx, self.entity, muzzle, player):
            in_car = player.get(Character).vehicle is not None
            player.get(Health).damage(self.damage * (self.in_car_factor if in_car else 1), source=self.entity)
        play(ctx, ctx.config(Sounds).police_shot, at=self.entity)
        ctx.emit(WeaponFired(by=self.entity, weapon=self.weapon, at=muzzle))

    def search(self, ctx, last_seen: Vec3):
        agent = self.entity.get(NavAgent)
        if agent.moving:
            return
        point = ctx.nav.random_point(last_seen, self.search_radius)
        if point is not None:
            agent.move_to(point)


@behavior("police_cruiser", requires=[Vehicle, Spotter], tick="significance")
class PoliceCruiser(Behavior):
    """Drives the street network toward the player (or the last sighting), rams if it must, and lets
    its officers out once it is close and has slowed down."""

    repath_every: float = param(0.5, unit="s")
    waypoint_radius: float = param(6, unit="m")
    deploy_range: float = param(14, unit="m")
    crew: int = param(2, min=0)
    route: list[Vec3] = state([])
    repath_in: float = state(0.0)
    deployed: bool = state(False)

    def update(self, ctx, dt):
        wanted = ctx.get(Wanted)
        vehicle = self.entity.get(Vehicle)
        if wanted.phase is Phase.CALM:
            vehicle.drive(brake=1)
            return
        player = ctx.world.query(tagged=Player).single()
        here = self.entity.transform.position
        target = player.transform.position if wanted.phase is Phase.CHASE else wanted.last_seen
        self.repath_in -= dt
        if self.repath_in <= 0:
            self.repath_in = self.repath_every
            self.route = ctx.nav.path(here, target)
        while self.route and here.distance_to(self.route[0]) < self.waypoint_radius:
            self.route.pop(0)
        goal = self.route[0] if self.route else target
        turn = wrap_angle(heading_to(here, goal) - self.entity.transform.euler.y)
        distance = here.distance_to(target)
        closing = distance > self.deploy_range
        vehicle.drive(
            throttle=1 if closing else 0,
            steer=clamp(turn / vehicle.steering, -1, 1),
            brake=0 if closing else 1,
        )
        if not self.deployed and not closing and abs(vehicle.speed) < 2:
            self.deploy(ctx)

    def deploy(self, ctx):
        self.deployed = True
        side = self.entity.transform.right
        for seat in range(self.crew):
            offset = side * (1.8 if seat % 2 == 0 else -1.8)
            ctx.world.spawn(Prefabs.police_officer, at=self.entity.transform.position + offset, tags=[Dispatched])


@behavior("police_helicopter", requires=[Light, Spotter])
class PoliceHelicopter(Behavior):
    """Hangs above the player (or the last sighting), trailing a little, searchlight on them. From up
    here it sees without line of sight, which is what makes four stars hard to shake. Once the pursuit
    is over it holds position until dispatch recalls it."""

    altitude: float = param(35, unit="m")
    speed: float = param(14, unit="m/s")
    rotor_rpm: float = param(380, min=0)
    rotor: float = state(0.0, doc="Main rotor angle, degrees.")

    def update(self, ctx, dt):
        self.spin_rotors(dt)
        wanted = ctx.get(Wanted)
        self.entity.get(Light).intensity = 6 if wanted.phase is Phase.CHASE else 3
        if wanted.phase is Phase.CALM:
            return
        player = ctx.world.query(tagged=Player).single()
        target = player.transform.position if wanted.phase is Phase.CHASE else wanted.last_seen
        transform = self.entity.transform
        transform.position = approach(transform.position, target + Vec3.UP * self.altitude, self.speed * dt)
        transform.look_at(target)

    def spin_rotors(self, dt):
        """The model's rotor hinges turn freely; the tail spins faster than the main rotor."""
        self.rotor = (self.rotor + self.rotor_rpm * 6 * dt) % 360
        model = self.entity.get(Model)
        model.pose("main_rotor", self.rotor)
        model.pose("tail_rotor", (self.rotor * 4) % 360)
