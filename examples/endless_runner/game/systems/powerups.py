"""Power-ups: what each one does."""

from parallax import System, approach, on, system
from project import Scenes

from game.components import Coin, Runner
from game.config import Rules
from game.content import PowerUpEffect
from game.events import PowerUpTaken
from game.resources import Run, buff, running


@system("powerups", scenes=[Scenes.street], when=running)
class PowerUps(System):
    """Timed power-ups (magnet, double coins, sprint board) go into `Run.buffs`
    with the time they run out, and whoever cares asks `buff(ctx, effect)`.
    Instant ones act here: a shield eats the next hit, the decoy whistle shoves
    the guard back. The magnet's pull lives here too, shared with the Lock-Up's
    passive magnet coil."""

    @on(PowerUpTaken)
    def taken(self, ctx, event: PowerUpTaken):
        run = ctx.get(Run)
        powerup = event.kind.data
        if powerup.seconds > 0:
            run.buffs[event.kind] = ctx.time.now + powerup.seconds
        elif powerup.effect is PowerUpEffect.SHIELD:
            run.shields += 1
        elif powerup.effect is PowerUpEffect.GUARD_SETBACK:
            run.guard_gap = min(run.gap_max, run.guard_gap + powerup.power)
        ctx.audio.play(powerup.sound, volume=powerup.volume)
        ctx.ui.toast(powerup.name)

    def update(self, ctx, dt):
        rules = ctx.config(Rules)
        run = ctx.get(Run)
        magnet = rules.magnet_radius if buff(ctx, PowerUpEffect.COIN_MAGNET) else 0
        radius = max(magnet, run.passive_magnet)
        runner, _ = ctx.world.query(Runner).single()
        here = runner.transform.position
        for coin in ctx.world.query(tagged=Coin).near(here, radius):
            coin.transform.position = approach(coin.transform.position, here, rules.magnet_pull * dt)
