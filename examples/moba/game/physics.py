from parallax.physics import Layers as BaseLayers, layer


class Layers(BaseLayers):
    terrain = layer()
    """Cliffs and jungle walls: block dashes and walking."""
    unit = layer()
