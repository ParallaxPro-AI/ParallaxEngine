from parallax import Behavior, WorldBar, behavior, state

from game.actions import DriveControls
from game.config import RaceRules
from game.rules import is_racing, put_back_on_track


@behavior("respawn_on_hold", requires=[WorldBar], when=is_racing)
class RespawnOnHold(Behavior):
    """Holding respawn puts the player's car back on the racing line, short of the gate
    it was heading for. A hold, not a press, so a stray tap can't cost a position. The
    hold is kept in the driver's WorldBar value; the HUD draws it as the template's ring."""

    held_for: float = state(0.0)

    def update(self, ctx, dt):
        hold = ctx.config(RaceRules).respawn_hold
        self.held_for = self.held_for + dt if ctx.input.held(DriveControls.respawn) else 0.0
        if self.held_for >= hold:
            self.held_for = 0.0
            put_back_on_track(ctx, self.entity.parent)
        bar = self.entity.get(WorldBar)
        bar.value = self.held_for / hold
        bar.shown = False

