from parallax import System, on, system
from project import Scenes

from game.config import FreightRules
from game.events import CareerEnded, CargoDelivered
from game.resources import Career, Outcome


@system("payoff", scenes=[Scenes.archipelago])
class Payoff(System):
    """The arc: bank the payoff target and the airfield is yours; run out of airframes
    and the bank calls in the loan. Either way the career is over and its save slot is
    cleared. The game-over screen follows `Career.outcome`."""

    @on(CargoDelivered)
    def check_the_bank(self, ctx, event):
        if ctx.get(Career).money >= ctx.config(FreightRules).payoff_target:
            ctx.emit(CareerEnded(won=True))

    @on(CareerEnded)
    def end_career(self, ctx, event):
        ctx.get(Career).outcome = Outcome.AIRFIELD_BOUGHT if event.won else Outcome.GROUNDED
        ctx.save.delete("career")
