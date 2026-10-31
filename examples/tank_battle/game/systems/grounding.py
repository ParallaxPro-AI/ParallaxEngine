"""Placed props sit on the terrain."""

from parallax import SceneLoaded, System, on, system

from game.battlefield import ground_y
from game.components import Grounded


@system("grounding")
class Grounding(System):
    """The battlefields' cover and dressing are placed by x and z; at load each Grounded
    prop drops onto the terrain under it (raised by its `lift`)."""

    @on(SceneLoaded)
    def settle(self, ctx, event):
        for entity, grounded in ctx.world.query(Grounded):
            spot = entity.transform.position
            entity.transform.position = spot.with_y(ground_y(ctx, spot) + grounded.lift)
