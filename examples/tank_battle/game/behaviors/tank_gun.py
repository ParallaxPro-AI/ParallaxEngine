from parallax import Behavior, Entity, Marker, Vec3, behavior, clamp, on, param, rotate_toward, state, vec3, wrap_angle
from parallax.combat import Health, LockOn
from project import Assets, Text

from game.actions import TankControls
from game.battlefield import shell_burst, view_angles
from game.components import EnemyTank, FireControlZone, Gunnery, Shellfire
from game.config import BattleRules, Sounds
from game.events import AmmoResupplied
from game.resources import Loadout


@behavior("tank_gun", requires=[Gunnery, Health])
class TankGun(Behavior):
    """The player's turret, main gun and field repair kit.

    The turret (the prefab's "turret" child) traverses toward where the chase camera
    looks, or by hand with Q/E; the gun (its "gun" child) elevates to the camera's pitch
    within `elevation_limits`. A shot is an instant hit along the barrel, out to `range`,
    and bursts where it lands. With a lock (F), a shot that passes close to the locked
    hull bends onto it. The ready rack empties, then reloads. Holding the fire-control
    zone makes every hit harder."""

    damage: float = param(35, min=0)
    range: float = param(50, unit="m")
    fire_interval: float = param(2, unit="s")
    rack: int = param(5, min=1, doc="Rounds before a reload.")
    reload_time: float = param(3, unit="s")
    traverse_rate: float = param(150, unit="deg/s")
    elevate_rate: float = param(120, unit="deg/s")
    elevation_limits: tuple[float, float] = param((-20.0, 45.0), unit="deg")
    repair_amount: float = param(50)
    repair_cooldown: float = param(15, unit="s")
    muzzle_height: float = param(1.4, unit="m")
    hull_radius: float = param(1.8, unit="m", doc="Aim radius of a medium hull, times its scale.")

    turret_yaw: float = state(0.0)
    elevation: float = state(0.0)
    ready_at: float = state(0.0)
    on_point: bool = state(False)
    marked: Entity | None = state(None)

    def start(self, ctx):
        gunnery = self.entity.get(Gunnery)
        gunnery.capacity = self.rack + ctx.get(Loadout).extra_ammo
        gunnery.ammo = gunnery.capacity
        self.turret_yaw = self.entity.transform.euler.y

    def update(self, ctx, dt):
        gunnery = self.entity.get(Gunnery)
        self.traverse(ctx, dt)
        self.watch_fire_point(ctx)
        self.lock_controls(ctx)
        if 0 <= gunnery.reload_done_at <= ctx.time.now:
            gunnery.ammo = gunnery.capacity
            gunnery.reload_done_at = -1
            ctx.audio.play(ctx.config(Sounds).rack, volume=0.4)
        if ctx.input.held(TankControls.fire) and gunnery.ammo > 0 and ctx.time.now >= self.ready_at:
            self.fire(ctx, gunnery)
        if ctx.input.pressed(TankControls.repair) and ctx.time.now >= gunnery.repair_ready_at:
            gunnery.repair_ready_at = ctx.time.now + self.repair_cooldown
            gunnery.repair_seconds = self.repair_cooldown
            amount = self.repair_amount + ctx.get(Loadout).repair_bonus
            self.entity.get(Health).heal(amount)
            ctx.ui.toast(ctx.text(Text.hull_repaired, amount=int(amount)), seconds=ctx.config(BattleRules).toast_seconds)
            ctx.audio.play(ctx.config(Sounds).repair, volume=0.45)

    def traverse(self, ctx, dt):
        manual = ctx.input.value(TankControls.traverse)
        rate = self.traverse_rate * ctx.get(Loadout).traverse_mul
        yaw, pitch = view_angles(ctx)
        if manual:
            self.turret_yaw += manual * rate * dt
        else:
            self.turret_yaw = rotate_toward(self.turret_yaw, yaw, rate * dt)
        low, high = self.elevation_limits
        self.elevation = rotate_toward(self.elevation, clamp(pitch, low, high), self.elevate_rate * dt)
        turret = self.entity.child("turret")
        turret.transform.local_euler = vec3(0, wrap_angle(self.turret_yaw - self.entity.transform.euler.y), 0)
        turret.child("gun").transform.local_euler = vec3(-self.elevation, 0, 0)

    def watch_fire_point(self, ctx):
        rules = ctx.config(BattleRules)
        inside = ctx.world.query(tagged=FireControlZone).near(self.entity.transform.position, rules.fire_point_radius).count() > 0
        if inside and not self.on_point:
            ctx.ui.toast(ctx.text(Text.fire_zone, bonus=round((rules.fire_point_damage_mul - 1) * 100)), seconds=rules.toast_seconds)
        self.on_point = inside

    def lock_controls(self, ctx):
        lock = self.entity.get(LockOn)
        if ctx.input.pressed(TankControls.lock):
            if lock.locked:
                lock.release()
            else:
                lock.lock()
        elif lock.locked and ctx.input.pressed(TankControls.cycle_next):
            lock.cycle(1)
        elif lock.locked and ctx.input.pressed(TankControls.cycle_prev):
            lock.cycle(-1)
        if lock.target != self.marked:  # the corner reticle follows the locked hull
            if self.marked is not None and self.marked.alive:
                self.marked.get(Marker).shown = False
            if lock.target is not None:
                lock.target.get(Marker).shown = True
            self.marked = lock.target

    def fire(self, ctx, gunnery):
        loadout, rules = ctx.get(Loadout), ctx.config(BattleRules)
        gunnery.ammo -= 1
        self.ready_at = ctx.time.now + self.fire_interval
        if gunnery.ammo == 0:
            gunnery.reload_seconds = max(0.5, self.reload_time * loadout.reload_mul)
            gunnery.reload_done_at = ctx.time.now + gunnery.reload_seconds
        muzzle = self.entity.transform.position + vec3(0, self.muzzle_height, 0)
        direction = self.assisted(ctx, muzzle, Vec3.from_yaw_pitch(self.turret_yaw, self.elevation))
        ctx.vfx.play(Assets.vfx.muzzle_flash, at=muzzle + direction * 3.6)
        ctx.audio.play(ctx.config(Sounds).cannon, volume=0.5)
        ctx.camera.main.shake(0.12, 0.15)
        hit = ctx.physics.raycast(muzzle, direction, self.range, ignore=[self.entity])
        if hit is None:
            return
        if hit.entity is not None and hit.entity.has(EnemyTank):
            damage = (self.damage + loadout.damage) * (rules.fire_point_damage_mul if self.on_point else 1)
            hit.entity.get(Health).damage(damage, source=self.entity, kind=Shellfire, point=hit.point)
        shell_burst(ctx, hit.point, source=self.entity)

    def assisted(self, ctx, muzzle: Vec3, direction: Vec3) -> Vec3:
        """The shot's line, bent onto the locked hull when it passes within the widened
        lock radius of it (close but not magnetic)."""
        target = self.entity.get(LockOn).target
        if target is None or not target.alive:
            return direction
        center = target.transform.position
        offset = center - muzzle
        along = offset.dot(direction)
        if along < 1 or along > self.range:
            return direction
        radius = self.hull_radius * target.transform.scale.x * ctx.config(BattleRules).lock_assist
        miss = (offset - direction * along).length()
        return offset.normalized() if miss <= radius else direction

    @on(AmmoResupplied)
    def resupply(self, ctx, event):
        gunnery = self.entity.get(Gunnery)
        gunnery.ammo = gunnery.capacity
        gunnery.reload_done_at = -1
        ctx.audio.play(ctx.config(Sounds).rack, volume=0.5)
