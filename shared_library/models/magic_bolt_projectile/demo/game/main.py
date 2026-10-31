"""Demo host for the magic_bolt_projectile model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="magic_bolt_projectile_demo", title="magic_bolt_projectile demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
