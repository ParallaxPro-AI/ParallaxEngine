from parallax import Behavior, Entity, Vec3, angle_between, behavior, param, state
from parallax.combat import Health
from parallax.physics import Rigidbody
from project import Assets, Prefabs

from game.actions import Helm
from game.components import Broadsides, Cannonball
from game.config import Sounds, VoyageRules
from game.content import Stat
from game.rules import refit, reload_scale, sailing, squall_raging


@behavior("broadsides", requires=[Broadsides, Rigidbody], when=sailing)
class BroadsidesBehavior(Behavior):
    """The captain's guns. Tap or hold port or starboard to fire that rack a ball at a time;
    an empty rack reloads as a whole. A ball fired at an enemy inside the side's arc is
    laid on it (aim assist, still ballistic); otherwise it flies straight out abeam.
    Damage, reach and reload come from the refit build; the rack size is a modifier."""

    damage: float = param(35)
    reach: float = param(42, unit="m")
    aim_cone: float = param(160, unit="deg")
    muzzle_speed: float = param(55, unit="m/s")
    elevation: float = param(3, unit="m/s", doc="Upward kick on every ball.")
    shot_gap: float = param(0.55, unit="s")
    reload_time: float = param(3.2, unit="s")

    cooldown: float = state(0.0)

    def update(self, ctx, dt):
        guns = self.entity.get(Broadsides)
        reload_time = max(0.4, self.reload_time * reload_scale(ctx))
        guns.port, guns.port_reload = self.reload(guns.port, guns.port_reload, guns.rack, reload_time, dt)
        guns.starboard, guns.starboard_reload = self.reload(guns.starboard, guns.starboard_reload, guns.rack,
                                                            reload_time, dt)
        self.cooldown = max(0.0, self.cooldown - dt)
        if self.cooldown > 0:
            return
        if self.trigger(ctx, Helm.fire_port) and guns.port:
            guns.port -= 1
            self.fire(ctx, side=-1)
        elif self.trigger(ctx, Helm.fire_starboard) and guns.starboard:
            guns.starboard -= 1
            self.fire(ctx, side=1)

    def trigger(self, ctx, side) -> bool:
        """Held fires a ball every shot_gap; a tap shorter than a frame is pressed but
        never held, and still fires one."""
        return ctx.input.pressed(side) or ctx.input.held(side)

    def reload(self, balls, progress, rack, reload_time, dt):
        """An empty rack reloads over `reload_time`, then fills completely."""
        if balls > 0:
            return balls, 0.0
        progress += dt / reload_time
        return (rack, 0.0) if progress >= 1 else (0, progress)

    def fire(self, ctx, side):
        self.cooldown = self.shot_gap
        hull = self.entity.transform
        abeam = hull.right * side
        muzzle = hull.position + abeam * 2.7 + hull.up * 3.3
        target = self.target_on_side(ctx, abeam)
        aim = (target.transform.position - muzzle).flat().normalized() if target else abeam.flat().normalized()
        velocity = aim * self.muzzle_speed + Vec3(0, self.elevation, 0) + self.entity.get(Rigidbody).velocity
        damage = self.damage + refit(ctx, Stat.CANNON_DAMAGE)
        ball = ctx.world.spawn(Prefabs.cannonball, at=muzzle, components=[Cannonball(shooter=self.entity, damage=damage)])
        ball.get(Rigidbody).velocity = velocity
        ctx.audio.play(ctx.config(Sounds).cannon, at=muzzle)
        ctx.vfx.play(Assets.vfx.muzzle_smoke, at=muzzle, direction=Vec3(abeam.x * 0.8, 0.18, abeam.z * 0.8))

    def target_on_side(self, ctx, abeam) -> Entity | None:
        """The nearest enemy in reach and inside this side's arc. Squalls shorten the reach."""
        squall = ctx.config(VoyageRules).storm_range_scale if squall_raging(ctx) else 1
        reach = (self.reach + refit(ctx, Stat.CANNON_RANGE)) * squall
        here = self.entity.transform.position
        in_arc = [
            enemy for enemy, _ in ctx.world.query(Health).near(here, reach)
            if ctx.combat.are_enemies(self.entity, enemy)
            and angle_between(abeam.flat(), (enemy.transform.position - here).flat()) <= self.aim_cone / 2
        ]
        return min(in_arc, key=lambda enemy: enemy.transform.position.distance_to(here), default=None)
