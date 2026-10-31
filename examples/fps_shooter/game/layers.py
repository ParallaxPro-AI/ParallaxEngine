"""Collision layers. Bullets are rays against `world` and `body`."""

from parallax import physics
from parallax.physics import layer


class Layers(physics.Layers):
    world = layer()
    body = layer()
    grenade = layer()
    pickup = layer()
