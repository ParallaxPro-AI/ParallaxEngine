from parallax import Behavior, Marker, behavior, param

from game.resources import Board
from game.rules import depot


@behavior("objective_beacon")
class ObjectiveBeaconBehavior(Behavior):
    """A pillar of light on the depot the job points at: the amber pickup beacon stands
    on the origin until the cargo is aboard, then the green drop-off beacon on the
    destination. Its child "tag" carries the HUD marker 18 m up. Derived every frame from
    the board, so taking, loading and delivering a job never has to move it."""

    drop_off: bool = param(False, doc="False: the pickup beacon; True: the drop-off beacon.")

    def late_update(self, ctx, dt):
        board = ctx.get(Board)
        contract = board.contract
        lit = contract is not None and board.loaded == self.drop_off
        self.entity.visible = lit
        self.entity.child("tag").get(Marker).shown = lit
        if lit:
            island = contract.destination if self.drop_off else contract.origin
            self.entity.transform.position = depot(ctx, island).transform.position
