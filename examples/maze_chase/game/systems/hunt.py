from parallax import System, on, system
from project import Scenes

from game.components import Gobbler, Stalker
from game.config import PaceTuning, Rules
from game.events import GobblerCaught, PipEaten, RoundStarted, StalkerEaten
from game.maze import board
from game.progress import current_level, getting_ready, knob, stalker_mode
from game.resources import Hunt, Mode


@system("hunt", scenes=[Scenes.maze], when=lambda ctx: not getting_ready(ctx))
class HuntClock(System):
    """The Stalkers' shared clock and their contact with the Gobbler. Scatter and
    chase alternate on a schedule; a flare frightens every Stalker for a while.
    Touching a frightened Stalker eats it; touching any other ends the round. The
    clock stands still through the READY freeze, but `RoundStarted` (emitted during
    it) still resets the clock."""

    def update(self, ctx, dt):
        hunt = ctx.get(Hunt)
        if hunt.phase_timer.tick(dt):
            self.enter(ctx, Mode.CHASE if hunt.phase is Mode.SCATTER else Mode.SCATTER)
        hunt.fright.tick(dt)
        self.check_contact(ctx)

    @on(RoundStarted, always=True)
    def round_started(self, ctx, event: RoundStarted):
        ctx.reset(Hunt)
        self.enter(ctx, Mode.SCATTER)

    @on(PipEaten, where=lambda event: event.flare)
    def flare_eaten(self, ctx, event: PipEaten):
        hunt = ctx.get(Hunt)
        hunt.fright.restart(current_level(ctx).fright_seconds * knob(ctx, ctx.config(PaceTuning).fright_seconds))
        hunt.chain = 0

    def enter(self, ctx, phase: Mode):
        rules = ctx.config(Rules)
        hunt = ctx.get(Hunt)
        hunt.phase = phase
        if phase is Mode.SCATTER:
            hunt.phase_timer.restart(rules.scatter_seconds * knob(ctx, ctx.config(PaceTuning).scatter_seconds))
        else:
            hunt.phase_timer.restart(rules.chase_seconds)

    def check_contact(self, ctx):
        """At most one catch per frame: two Stalkers touching at once cost one life."""
        gobbler = ctx.world.query(tagged=Gobbler).single()
        reach = ctx.config(Rules).touch_distance * board(ctx).cell_size.x
        for entity, stalker in ctx.world.query(Stalker).near(gobbler.transform.position, reach):
            mode = stalker_mode(ctx, stalker)
            if mode is Mode.FRIGHTENED:
                stalker.eaten = True
                hunt = ctx.get(Hunt)
                hunt.chain += 1
                ctx.emit(StalkerEaten(stalker=entity, chain=hunt.chain))
            elif mode is not Mode.EATEN:
                ctx.emit(GobblerCaught())
                return
