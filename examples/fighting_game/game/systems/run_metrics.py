from parallax import System, on, system

from game.components import Challenger, Fighter
from game.events import ExchangeResolved, RunEnded, Whiffed
from game.resources import RunStats


@system("run_metrics")
class RunMetrics(System):
    """Counts what the result screen reports: hits, guards, punishes, best combo, whiffs."""

    @on(ExchangeResolved)
    def exchanged(self, ctx, event: ExchangeResolved):
        stats = ctx.get(RunStats)
        if event.blocked:
            if event.defender.has(Challenger):
                stats.blocks += 1
        elif event.attacker.has(Challenger):
            stats.hits += 1
            if event.punish:
                stats.punishes += 1
            stats.best_combo = max(stats.best_combo, event.defender.get(Fighter).hits_in_combo)

    @on(Whiffed)
    def whiffed(self, ctx, event: Whiffed):
        if event.entity.has(Challenger):
            ctx.get(RunStats).whiffs += 1

    @on(RunEnded)
    def run_ended(self, ctx, event: RunEnded):
        ctx.get(RunStats).won = event.won
