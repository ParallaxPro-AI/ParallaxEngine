from parallax import System, system

from game.components import Racer, TrackScene
from game.resources import Race, RacePhase
from game.rules import racing_line
from game.track import race_order


@system("standings", scenes=[TrackScene], when=lambda ctx: ctx.get(Race).phase is not RacePhase.GRID)
class Standings(System):
    """Ranks the field every frame once the grid is built: finishers by finishing
    place, then whoever has passed the most gates, then whoever is closest to their
    next one."""

    def update(self, ctx, dt):
        line = racing_line(ctx)
        field = sorted(ctx.world.query(Racer), key=lambda row: race_order(line, row[0].transform.position, row[1]))
        for place, (_, racer) in enumerate(field, start=1):
            racer.place = place
