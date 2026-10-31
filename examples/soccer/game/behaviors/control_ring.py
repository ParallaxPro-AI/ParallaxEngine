from parallax import Behavior, Entity, Handle, behavior, param, state, vec3
from project import Text

from game.resources import Match


@behavior("control_ring")
class ControlRing(Behavior):
    """Follows the feet of the player you control, and keeps the template's bobbing
    YOU tag over their head. The broadcast camera frames the ball and this anchor, so
    a switch across the pitch pulls the view along."""

    lift: float = param(0.05, unit="m", doc="Height above the turf.")
    tag_height: float = param(2.3, unit="m", doc="Where the YOU tag floats above the feet.")

    tagged: Entity | None = state(None)
    tag: Handle | None = state(None)

    def late_update(self, ctx, dt):
        player = ctx.get(Match).controlled
        self.entity.transform.position = player.transform.position.with_y(self.lift)
        if player != self.tagged:
            if self.tag is not None:
                self.tag.cancel()
            self.tag = ctx.ui.label(player, Text.you_tag, offset=vec3(0, self.tag_height, 0), kind="you")
            self.tagged = player
