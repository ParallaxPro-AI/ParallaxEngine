"""How Sam moves, recovers and shoots, and how weapon caches restock."""

import random

from parallax import Behavior, PrefabRef, Quat, Vec3, behavior, heading_to, on, param, state, vec3
from parallax.characters import Character
from parallax.combat import Damaged, Health

from features.on_foot.actions import OnFootControls
from features.on_foot.components import Arsenal, WeaponPickup
from features.on_foot.events import WeaponFired
from features.on_foot.resources import Location
from game.audio import Sounds, play


@behavior("player_movement", requires=[Character, Health])
class PlayerMovement(Behavior):
    """Camera-relative walking and running, and jumping. The vehicle moves him while he drives."""

    def update(self, ctx, dt):
        body = self.entity.get(Character)
        if body.vehicle is not None:
            return
        if self.entity.get(Health).dead:
            body.stop()
            return
        direction = ctx.camera.main.relative(ctx.input.axis(OnFootControls.move))
        body.move(direction, run=ctx.input.held(OnFootControls.run))
        if ctx.input.pressed(OnFootControls.jump):
            body.jump()


@behavior("take_cover", requires=[Character, Health])
class TakeCover(Behavior):
    """C beside something solid (a wall, a car, a crate) ducks behind it; C again, or walking off,
    stands back up. Cover is physical: crouched lower than what is in front of him, the police's
    line of fire hits the obstacle instead (officers check it before every shot)."""

    reach: float = param(1.6, unit="m", doc="How close the cover must be, ahead of where he faces.")
    covered: bool = state(False)
    spot: Vec3 = state(Vec3.ZERO)

    def update(self, ctx, dt):
        body = self.entity.get(Character)
        if self.covered and (body.vehicle is not None or self.entity.get(Health).dead
                             or self.entity.transform.position.distance_to(self.spot) > self.reach):
            self.leave(body)
        if not ctx.input.pressed(OnFootControls.cover) or body.vehicle is not None:
            return
        if self.covered:
            self.leave(body)
            return
        here = self.entity.transform.position + Vec3.UP * 0.7
        hit = ctx.physics.raycast(here, self.entity.transform.forward.flat().normalized(), self.reach, ignore=[self.entity])
        if hit is not None and hit.entity is not None and body.set_stance("crouch"):
            self.covered = True
            self.spot = self.entity.transform.position

    def leave(self, body: Character):
        if body.set_stance("stand"):
            self.covered = False


@behavior("player_vitals", requires=[Health])
class PlayerVitals(Behavior):
    """Health comes back on its own after a while without being hurt."""

    regen_delay: float = param(8, unit="s")
    regen_rate: float = param(10, unit="/s")
    since_hurt: float = state(99.0)

    @on(Damaged)
    def wounded(self, ctx, event: Damaged):
        self.since_hurt = 0.0

    def update(self, ctx, dt):
        health = self.entity.get(Health)
        self.since_hurt += dt
        if not health.dead and self.since_hurt >= self.regen_delay and health.current < health.max:
            health.heal(self.regen_rate * dt)


@behavior("gunplay", requires=[Arsenal, Character, Health])
class Gunplay(Behavior):
    """Fire at what the camera looks at, reload, switch weapons. Every shot is a WeaponFired that the
    police and the crowd hear. No shooting indoors; in a car or through the phone the controls are off."""

    muzzle_height: float = param(1.4, unit="m")
    cooldown: float = state(0.0)
    reloading: float = state(0.0)

    def update(self, ctx, dt):
        self.cooldown = max(0.0, self.cooldown - dt)
        arsenal = self.entity.get(Arsenal)
        if self.reloading > 0:
            self.reloading -= dt
            if self.reloading <= 0:
                self.finish_reload(arsenal)
                play(ctx, ctx.config(Sounds).reload_done, at=self.entity)
        if self.entity.get(Health).dead or ctx.get(Location).interior is not None:
            return
        if ctx.input.pressed(OnFootControls.next_weapon):
            self.switch(arsenal)
            play(ctx, ctx.config(Sounds).weapon_draw, at=self.entity)
        elif ctx.input.pressed(OnFootControls.reload):
            self.start_reload(ctx, arsenal)
        elif self.trigger(ctx) and self.cooldown == 0 and self.reloading <= 0:
            self.fire(ctx, arsenal)

    def trigger(self, ctx) -> bool:
        """A click that goes down and up within one frame still fires; holding keeps firing."""
        return ctx.input.pressed(OnFootControls.fire) or ctx.input.held(OnFootControls.fire)

    def switch(self, arsenal: Arsenal):
        index = arsenal.owned.index(arsenal.current)
        arsenal.current = arsenal.owned[(index + 1) % len(arsenal.owned)]
        self.reloading = 0.0

    def start_reload(self, ctx, arsenal: Arsenal):
        weapon = arsenal.current
        if not weapon.data.melee and arsenal.reserve.get(weapon, 0) > 0 and arsenal.loaded.get(weapon, 0) < weapon.data.magazine:
            self.reloading = weapon.data.reload_time
            play(ctx, ctx.config(Sounds).reload, at=self.entity)

    def finish_reload(self, arsenal: Arsenal):
        weapon = arsenal.current
        moved = min(weapon.data.magazine - arsenal.loaded.get(weapon, 0), arsenal.reserve.get(weapon, 0))
        arsenal.loaded[weapon] = arsenal.loaded.get(weapon, 0) + moved
        arsenal.reserve[weapon] -= moved

    def fire(self, ctx, arsenal: Arsenal):
        weapon = arsenal.current.data
        if not weapon.melee and arsenal.loaded.get(arsenal.current, 0) == 0:
            if arsenal.reserve.get(arsenal.current, 0) == 0:
                play(ctx, ctx.config(Sounds).dry_fire, at=self.entity)
            self.start_reload(ctx, arsenal)
            return
        muzzle = self.entity.transform.position + Vec3.UP * self.muzzle_height
        aim = (self.aim_point(ctx, weapon.range) - muzzle).normalized()
        self.entity.get(Character).face(heading_to(muzzle, muzzle + aim))
        self.cooldown = weapon.interval
        landed = False
        if weapon.melee:
            for target in ctx.physics.overlap(muzzle + aim.flat() * 0.8, 0.8, ignore=[self.entity]):
                if target.has(Health):
                    target.get(Health).damage(weapon.damage, source=self.entity)
        else:
            arsenal.loaded[arsenal.current] -= 1
            for _ in range(weapon.pellets):
                tilt = vec3(random.uniform(-1, 1), random.uniform(-1, 1), 0) * weapon.spread
                hit = ctx.physics.raycast(muzzle, Quat.from_euler(tilt).rotate(aim), weapon.range, ignore=[self.entity])
                if hit is not None and hit.entity is not None and hit.entity.has(Health):
                    hit.entity.get(Health).damage(weapon.damage, source=self.entity)
                    landed = True
            ctx.emit(WeaponFired(by=self.entity, weapon=arsenal.current, at=muzzle))
        ctx.audio.play(weapon.sound, at=self.entity, volume=weapon.volume)
        if landed:
            play(ctx, ctx.config(Sounds).bullet_hit, at=self.entity)

    def aim_point(self, ctx, reach: float) -> Vec3:
        """Where the centre of the screen points, up to `reach` metres past the player. The ray starts
        level with the player, so a porch roof or a wall between him and the camera isn't the target."""
        origin, direction = ctx.camera.main.ray()
        start = origin + direction * max(0.0, (self.entity.transform.position - origin).dot(direction))
        hit = ctx.physics.raycast(start, direction, reach + 10, ignore=[self.entity])
        return hit.point if hit is not None else start + direction * (reach + 10)


@behavior("pickup_spawner")
class PickupSpawner(Behavior):
    """A spot that keeps one pickup on it, restocking `restock` seconds after it is taken. Whether it is
    stocked is read from the world, so no handle to the spawned pickup has to survive a save."""

    prefab: PrefabRef = param()
    restock: float = param(45, unit="s")
    reach: float = param(1, unit="m", doc="A pickup this close counts as on the spot.")
    waited: float = state(0.0)

    def start(self, ctx):
        if not self.stocked(ctx):
            self.stock(ctx)

    def update(self, ctx, dt):
        if self.stocked(ctx):
            self.waited = 0.0
            return
        self.waited += dt
        if self.waited >= self.restock:
            self.stock(ctx)

    def stocked(self, ctx) -> bool:
        return ctx.world.query(WeaponPickup).near(self.entity.transform.position, self.reach).count() > 0

    def stock(self, ctx):
        self.waited = 0.0
        ctx.world.spawn(self.prefab, at=self.entity.transform.position)
