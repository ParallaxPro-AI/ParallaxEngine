"""Collision layers."""

from parallax import physics
from parallax.physics import layer


class Layers(physics.Layers):
    hull = layer()
    shell = layer()
    prop = layer()
