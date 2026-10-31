from parallax import Context, SceneLoaded, System, on, system
from parallax.combat import Died, Health
from project import Placed, Scenes

from game.components import Keeper
from game.effects import apply_effect
from game.events import Descended, RunBanked, RunWon
from game.resources import Outcome, Run, Vault
from game.rules import Rules, Sounds


@system("run_flow", scenes=[Scenes.cellar])
class RunFlow(System):
    """A run's life: it starts from the rules plus the vault's boons, descends floor by
    floor carrying the keeper's health, and ends in a fall, a win, or the keeper walking
    out (`walk_out`). Every ending banks the coins carried out."""

    @on(SceneLoaded, where=lambda event: event.new_run)
    def run_started(self, ctx, event: SceneLoaded):
        """A new run: the loadout from the rules (health from the keeper prefab), then
        every vault boon at its level."""
        rules = ctx.config(Rules)
        run = ctx.get(Run)
        run.coins = rules.start_coins
        run.bombs = rules.start_bombs
        run.keys = rules.start_keys
        run.move_speed = rules.move_speed
        run.fire_interval = rules.fire_interval
        run.shard_damage = rules.shard_damage
        run.shard_speed = rules.shard_speed
        for boon, level in ctx.get(Vault).levels.items():
            for _ in range(level):
                apply_effect(ctx, boon.data.effect, boon.data.amount)

    @on(SceneLoaded, where=lambda event: not event.new_run)
    def floor_reached(self, ctx, event: SceneLoaded):
        """The scene reload recreated the keeper; give it back the wounds it carried down."""
        run = ctx.get(Run)
        health = ctx.world.placed(Placed.keeper).get(Health)
        health.max = run.max_health
        health.current = run.health

    @on(Descended)
    def descended(self, ctx, event: Descended):
        run = ctx.get(Run)
        health = ctx.world.placed(Placed.keeper).get(Health)
        run.health = health.current
        run.max_health = health.max
        run.floor += 1
        ctx.audio.play(ctx.config(Sounds).descend)
        ctx.scenes.reload()

    @on(Died, where=lambda event: event.entity.has(Keeper))
    def fell(self, ctx, event: Died):
        ctx.audio.play(ctx.config(Sounds).death)
        self.finish(ctx, Outcome.FELL)

    @on(RunWon)
    def won(self, ctx, event: RunWon):
        ctx.audio.play(ctx.config(Sounds).victory)
        self.finish(ctx, Outcome.WON)

    def finish(self, ctx, outcome: Outcome):
        """Decides the run, which opens the end-of-run panel."""
        ctx.get(Run).outcome = outcome
        bank(ctx, won=outcome is Outcome.WON)


def bank(ctx: Context, *, won: bool) -> None:
    """Pay what the keeper carries out (plus the win bonus) into the vault."""
    run = ctx.get(Run)
    run.coins_banked = run.coins + (ctx.config(Rules).win_coin_bonus if won else 0)
    ctx.emit(RunBanked(coins=run.coins_banked, won=won, floor=run.floor + 1))


def walk_out(ctx: Context) -> None:
    """The pause menu's way out: bank what you carry and go back to the title."""
    bank(ctx, won=False)
    ctx.scenes.load(Scenes.title, new_run=True)
