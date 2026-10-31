from parallax import Behavior, behavior, param, state
from parallax.combat import Health
from parallax.hud import Crosshair
from parallax.viewmodel import Viewmodel
from parallax.physics import Rigidbody
from project import Assets

from game.actions import FpsControls
from game.arena import restock
from game.audio import play
from game.components import Arsenal
from game.content import WeaponKind
from game.gunplay import fire_bullet, scatter


@behavior("gunner", requires=[Arsenal, Health, Crosshair])
class Gunner(Behavior):
    """The player's weapons. Number keys or the wheel switch weapons, the trigger fires
    (held for automatics), R reloads from reserve (an empty magazine reloads by itself),
    and zoom aims down sights or through the scope. Shots leave from the first-person
    camera along its view. Grenades are thrown, not fired."""

    hip_fov: float = param(75, unit="deg")

    ready_at: float = state(0.0)
    mag_in_at: float = state(-1.0)
    bolt_at: float = state(-1.0)

    def start(self, ctx):
        restock(self.entity.get(Arsenal))

    def update(self, ctx, dt):
        if self.entity.get(Health).dead:
            self.mag_in_at = self.bolt_at = -1.0
            return
        arsenal = self.entity.get(Arsenal)
        self.switch(ctx, arsenal)
        weapon = arsenal.weapons[arsenal.current]
        self.foley(ctx)
        if 0 <= arsenal.reload_done_at <= ctx.time.now:
            self.finish_reload(arsenal, weapon)
        self.aim(ctx, arsenal, weapon.data)
        if ctx.input.pressed(FpsControls.reload):
            self.start_reload(ctx, arsenal, weapon)
        trigger = ctx.input.held if weapon.data.automatic else ctx.input.pressed
        if trigger(FpsControls.fire) and ctx.time.now >= self.ready_at and arsenal.reload_done_at < 0:
            if arsenal.loaded[weapon] > 0:
                self.fire(ctx, arsenal, weapon)
            else:
                self.start_reload(ctx, arsenal, weapon)

    def switch(self, ctx, arsenal):
        choice = ctx.input.pressed_index(FpsControls.weapon_slot)
        wheel = ctx.input.value(FpsControls.switch_weapon)
        if wheel:
            choice = (arsenal.current + (1 if wheel > 0 else -1)) % len(arsenal.weapons)
        if choice is not None and choice < len(arsenal.weapons) and choice != arsenal.current:
            arsenal.current = choice
            arsenal.reload_done_at = -1
            self.mag_in_at = self.bolt_at = -1.0
            self.hands(ctx).item = arsenal.weapons[choice].data.view

    def aim(self, ctx, arsenal, weapon):
        # A scope toggles on a press (sniper); iron sights aim while the button is held.
        if weapon.zoom_fov <= 0:
            zoomed = False
        elif weapon.scoped:
            zoomed = not arsenal.zoomed if ctx.input.pressed(FpsControls.zoom) else arsenal.zoomed
        else:
            zoomed = ctx.input.held(FpsControls.zoom)
        if zoomed != arsenal.zoomed:
            arsenal.zoomed = zoomed
            ctx.camera.main.zoom_to(weapon.zoom_fov if zoomed else self.hip_fov, weapon.zoom_time)
            self.hands(ctx).aim(zoomed)
        crosshair = self.entity.get(Crosshair)
        crosshair.style = "scope" if zoomed and weapon.scoped else "dot" if zoomed else "cross"
        crosshair.spread = 0 if zoomed else weapon.spread
        crosshair.reload = None if arsenal.reload_done_at < 0 else \
            1 - (arsenal.reload_done_at - ctx.time.now) / weapon.reload_time

    def fire(self, ctx, arsenal, weapon):
        gun = weapon.data
        arsenal.loaded[weapon] -= 1
        self.ready_at = ctx.time.now + gun.fire_interval
        eye, aim = ctx.camera.main.ray()
        if gun.report is not None:
            play(ctx, gun.report)
        if gun.kind is WeaponKind.THROWN:
            self.hands(ctx).play("throw")
            grenade = ctx.world.spawn(gun.projectile, at=eye + aim * 0.6,
                                      params={"grenade": {"thrower": self.entity, "damage": gun.damage}})
            grenade.get(Rigidbody).velocity = aim * gun.throw_speed
            return
        fire_bullet(ctx, self.entity, eye, scatter(aim, 0 if arsenal.zoomed else gun.spread),
                    damage=gun.damage, range=gun.range, tracer=gun.tracer)
        ctx.vfx.play(Assets.vfx.muzzle_flash, at=eye + aim)
        ctx.camera.main.kick(gun.recoil)
        self.hands(ctx).fire()

    def start_reload(self, ctx, arsenal, weapon):
        if arsenal.reload_done_at >= 0 or arsenal.reserve[weapon] == 0 or arsenal.loaded[weapon] == weapon.data.magazine:
            return
        arsenal.reload_done_at = ctx.time.now + weapon.data.reload_time
        # The template's reload foley: mag out now, mag in at 68 %, the bolt at 88 %.
        ctx.audio.play(Assets.sfx.dm_mag_out)
        self.mag_in_at = ctx.time.now + weapon.data.reload_time * 0.68
        self.bolt_at = ctx.time.now + weapon.data.reload_time * 0.88
        self.hands(ctx).play("reload", seconds=weapon.data.reload_time)

    def foley(self, ctx):
        if 0 <= self.mag_in_at <= ctx.time.now:
            self.mag_in_at = -1.0
            ctx.audio.play(Assets.sfx.dm_mag_in)
        if 0 <= self.bolt_at <= ctx.time.now:
            self.bolt_at = -1.0
            ctx.audio.play(Assets.sfx.dm_bolt)

    def hands(self, ctx) -> Viewmodel:
        """The first-person viewmodel under the camera (the held gun)."""
        return ctx.camera.main.entity.child("hands").get(Viewmodel)

    def finish_reload(self, arsenal, weapon):
        moved = min(weapon.data.magazine - arsenal.loaded[weapon], arsenal.reserve[weapon])
        arsenal.loaded[weapon] += moved
        arsenal.reserve[weapon] -= moved
        arsenal.reload_done_at = -1
