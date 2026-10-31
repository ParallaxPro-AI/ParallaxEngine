"""Demo host for the marina_pontoon model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="marina_pontoon_demo", title="marina_pontoon demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
