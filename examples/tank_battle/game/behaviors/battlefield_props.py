from parallax import Behavior, behavior, on, param, state
from parallax.combat import Health
from project import Assets, Text

from game.components import Blast, EnemyTank, Gunnery, PlayerTank
from game.config import BattleRules, Sounds
from game.events import AmmoResupplied, DrumLit


@behavior("fuel_drum")
class FuelDrum(Behavior):
    """Any shell that bursts next to a fuel drum (yours or theirs) cooks it off: `damage`
    to every enemy tank in `radius`, and `self_damage` to you if you're inside it too.
    Whoever lit it gets the kills."""

    radius: float = param(13, unit="m")
    damage: float = param(110, min=0)
    self_damage: float = param(55, min=0)

    spent: bool = state(False)

    @on(DrumLit)
    def cook_off(self, ctx, event):
        if self.spent:
            return
        self.spent = True
        center = self.entity.transform.position
        shooter = event.by if event.by is not None and event.by.alive else None
        for tank in ctx.world.query(EnemyTank).near(center, self.radius).entities():
            tank.get(Health).damage(self.damage, source=shooter, kind=Blast, point=center)
        player = ctx.world.query(tagged=PlayerTank).near(center, self.radius).first()
        ctx.ui.toast(Text.caught_in_blast if player is not None else Text.drum_detonated,
                     seconds=ctx.config(BattleRules).toast_seconds)
        if player is not None:
            player.get(Health).damage(self.self_damage, kind=Blast, point=center)
        ctx.vfx.play(Assets.vfx.fuel_explosion, at=center)
        ctx.audio.play(ctx.config(Sounds).cannon, at=center, volume=0.6)
        ctx.camera.main.shake(0.8, 0.42)
        self.entity.destroy()


@behavior("ammo_crate")
class AmmoCrate(Behavior):
    """Drive within `radius` to refill the ready rack at once (cancelling a reload). Then
    it goes cold for `cooldown` seconds, so you route through crates mid-fight instead of
    parking on them."""

    radius: float = param(7, unit="m")
    cooldown: float = param(20, unit="s")

    ready_at: float = state(0.0)

    def update(self, ctx, dt):
        if ctx.time.now < self.ready_at:
            return
        tanks = ctx.world.query(Gunnery).near(self.entity.transform.position, self.radius).entities()
        if tanks:
            tank = tanks[0]
            self.ready_at = ctx.time.now + self.cooldown
            ctx.emit(AmmoResupplied(tank=tank))
            ctx.ui.toast(Text.ammo_resupplied, seconds=ctx.config(BattleRules).toast_seconds)
            ctx.vfx.play(Assets.vfx.resupply, at=self.entity.transform.position)
            ctx.audio.play(ctx.config(Sounds).rack, volume=0.45)
