"""Kills: score, wrecks, damage numbers and the HE Rounds splash."""

from parallax import Color, System, on, system, vec3
from parallax.combat import Damaged, Died

from game.battlefield import shell_burst
from game.components import BattlefieldScene, Blast, EnemyTank, PlayerTank
from game.resources import Campaign, Career, Loadout

DAMAGE_NUMBER = Color.hex("#f8d34a")


@system("scoring", scenes=[BattlefieldScene])
class Scoring(System):
    """Every enemy hull scores its tier's value. Hits on enemy hulls flash them and float
    a damage number. With HE Rounds, a kill of yours cooks the wreck off and hurts the
    tanks around it (never you). A wreck going up also lights the fuel drums beside it."""

    @on(Damaged, where=lambda event: event.entity.has(EnemyTank))
    def hull_hit(self, ctx, event):
        ctx.ui.flash(event.entity)
        ctx.ui.float_text(str(round(event.amount)), event.entity.transform.position + vec3(0, 2.4, 0), color=DAMAGE_NUMBER)

    @on(Died, where=lambda event: event.entity.has(EnemyTank))
    def hull_destroyed(self, ctx, event):
        campaign = ctx.get(Campaign)
        campaign.score += event.entity.get(EnemyTank).kind.data.score
        campaign.kills += 1
        ctx.get(Career).total_kills += 1
        wreck = event.entity.transform.position
        ctx.camera.main.shake(0.55, 0.42)
        shell_burst(ctx, wreck, source=event.source, size="large")
        loadout = ctx.get(Loadout)
        if loadout.splash_radius > 0 and event.source is not None and event.source.has(PlayerTank):
            ctx.combat.area_damage(wreck, loadout.splash_radius, loadout.splash_damage,
                                   source=event.source, kind=Blast, falloff=False)
