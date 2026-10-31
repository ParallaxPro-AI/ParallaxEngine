from parallax import Behavior, Shape, TextMesh, behavior

from game.board import tile_def
from game.components import Tile


@behavior("tile_face", requires=[Tile, Shape, TextMesh])
class TileFace(Behavior):
    """Paints the tile and its bold number from the ladder entry for its value."""

    def update(self, ctx, dt):
        value = self.entity.get(Tile).value
        face = tile_def(ctx, value)
        self.entity.get(Shape).color = face.color
        label = self.entity.get(TextMesh)
        label.text = f"[b]{value}[/b]"
        label.color = face.text_color
        label.size = face.text_size
