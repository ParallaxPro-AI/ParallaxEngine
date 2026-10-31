from parallax import Behavior, TriggerEntered, behavior, on

from game.events import Descended


@behavior("exit_pad")
class ExitPad(Behavior):
    """Stepping on the pad takes the keeper down to the next floor."""

    @on(TriggerEntered)
    def touched(self, ctx, event: TriggerEntered):
        ctx.emit(Descended())
