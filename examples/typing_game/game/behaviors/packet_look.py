from parallax import Behavior, Shape, behavior

from game.components import Word


@behavior("packet_look", requires=[Word, Shape])
class PacketLook(Behavior):
    """Paints and sizes the packet as its kind says."""

    def start(self, ctx):
        kind = self.entity.get(Word).kind.data
        shape = self.entity.get(Shape)
        shape.color = kind.color
        shape.size = kind.size
