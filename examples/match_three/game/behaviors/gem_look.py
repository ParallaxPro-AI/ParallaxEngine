from parallax import Behavior, Sprite, behavior

from game.components import Gem
from game.match_logic import Special


@behavior("gem_look", requires=[Gem, Sprite])
class GemLook(Behavior):
    """Dresses a gem in its kind's sprite at its native size, and shows the badge of
    the special it carries (both badges are children in the gem prefab)."""

    def start(self, ctx):
        kind = self.entity.get(Gem).kind.data
        sprite = self.entity.get(Sprite)
        sprite.image = kind.image
        sprite.size = kind.size

    def update(self, ctx, dt):
        special = self.entity.get(Gem).special
        self.entity.child("line_badge").visible = special is Special.LINE
        self.entity.child("bomb_badge").visible = special is Special.BOMB
