from parallax import System, system

from game.components import Chef, Pot, PotState, Station
from game.content import ServiceRules
from game.recipes import Act, plan
from game.resources import cooking


@system("guide", when=cooking)
class Guide(System):
    """Wayfinding: each chef's goal is the nearest station whose recipe step would take
    what that chef is holding (a ready or burnt pot counts for empty hands) — the same
    table the hands apply, so it never points at a station that would do nothing. The
    bin takes anything, so it is only a goal for burnt food. The chef's guide panel pins
    it (game/ui.py)."""

    def update(self, ctx, dt):
        rules = ctx.config(ServiceRules)
        for player in ctx.players:
            chef = player.entity
            if chef is None:
                continue
            here = chef.transform.position
            held = chef.get(Chef).held
            chef.get(Chef).goal = next(
                (station for station, _ in ctx.world.query(Station).near(here, rules.guide_range).by_distance(here)
                 if wanted(station, held, rules)), None)


def wanted(station, held, rules: ServiceRules) -> bool:
    """Would this station move the dish in these hands on?"""
    pot = station.try_get(Pot)
    if pot is not None and pot.state is not PotState.EMPTY:
        return held is None and pot.state is not PotState.COOKING
    action = plan(station, held)
    if action is None or action.act is Act.WAIT:
        return False
    if action.step is not None and action.step.takes_anything:
        return held == rules.burnt
    return True
