from parallax import System, on, system
from parallax.combat import Health
from project import Placed

from game.components import Corner
from game.events import BoutEnded, BoutStarted, RoundEnded, RunEnded
from game.resources import Career, Match, Mode
from game.rules import Rules, in_mode

in_circuit = in_mode(Mode.CIRCUIT)


@system("career_records")
class CareerRecords(System):
    """Keeps the player's profile: bouts, wins, belts, perfect rounds and where to
    continue. Only the circuit counts, except that finishing training is remembered."""

    @on(BoutStarted, when=in_circuit)
    def bout_started(self, ctx, event: BoutStarted):
        ctx.get(Career).checkpoint = event.stage

    @on(RoundEnded, when=in_circuit, where=lambda event: event.winner is Corner.CHALLENGER)
    def round_won(self, ctx, event: RoundEnded):
        if ctx.world.placed(Placed.challenger).get(Health).fraction == 1:
            ctx.get(Career).perfect_rounds += 1

    @on(BoutEnded, when=in_circuit)
    def bout_ended(self, ctx, event: BoutEnded):
        career = ctx.get(Career)
        career.bouts += 1
        if event.won:
            career.wins += 1
            career.best_challenger = max(career.best_challenger, event.stage + 1)
            if event.stage == len(ctx.config(Rules).ladder) - 1:
                career.belts += 1

    @on(RunEnded)
    def run_ended(self, ctx, event: RunEnded):
        match = ctx.get(Match)
        career = ctx.get(Career)
        if match.mode is Mode.CIRCUIT:
            career.checkpoint = -1 if event.won else match.stage
        elif match.mode is Mode.TRAINING and event.won:
            career.training_done = True
