"""Collision layers. Thorns only touch husks; motes only exist to be clicked."""

from parallax import physics
from parallax.physics import layer


class Layers(physics.Layers):
    plant = layer()
    husk = layer()
    thorn = layer()
    pollen = layer()
