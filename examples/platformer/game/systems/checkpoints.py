"""Where a death sends you back to."""

from parallax import System, TriggerEntered, on, system
from parallax.characters import Landed
from project import Text

from game.components import Checkpoint, Hazard, Level, Player, SafeGround, player_touches
from game.config import Rules
from game.resources import Attempt, alive


def on_safe_ground(event: Landed) -> bool:
    """The player landed on solid island ground."""
    return event.entity.has(Player) and event.target is not None and event.target.has(SafeGround)


@system("checkpoints", scenes=[Level])
class Checkpoints(System):
    """Two ways to move your respawn point forward. Flags: touch one and it's
    yours. Quiet autosaves: landing on solid island ground (never a moving or
    crumbling platform, which would be empty air by the time you respawn),
    clear of hazards and a little further on than the last save."""

    @on(TriggerEntered, when=alive, where=player_touches(Checkpoint))
    def flag(self, ctx, event: TriggerEntered):
        attempt = ctx.get(Attempt)
        position = event.entity.transform.position
        if position.x <= attempt.spawn.x:
            return
        attempt.spawn = position
        ctx.ui.toast(Text.notice_checkpoint)

    @on(Landed, when=alive, where=on_safe_ground)
    def landed(self, ctx, event: Landed):
        rules = ctx.config(Rules)
        attempt = ctx.get(Attempt)
        feet = event.entity.transform.position
        if feet.x - attempt.spawn.x < rules.checkpoint_min_gap:
            return
        if ctx.world.query(tagged=Hazard).near(feet, rules.checkpoint_clearance).first():
            return
        attempt.spawn = feet
