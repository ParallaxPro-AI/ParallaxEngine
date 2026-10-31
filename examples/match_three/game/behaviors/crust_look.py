from parallax import Behavior, Sprite, behavior, param

from game.components import Crust


@behavior("crust_look", requires=[Crust, Sprite])
class CrustLook(Behavior):
    """Draws thick crust nearly opaque and its last layer faint, so the player can
    read how many hits a cell still needs."""

    thick_alpha: float = param(0.92, min=0, max=1)
    thin_alpha: float = param(0.58, min=0, max=1)

    def update(self, ctx, dt):
        sprite = self.entity.get(Sprite)
        thick = self.entity.get(Crust).layers > 1
        sprite.color = sprite.color.with_alpha(self.thick_alpha if thick else self.thin_alpha)
