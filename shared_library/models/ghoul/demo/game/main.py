"""Demo host for the ghoul model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="ghoul_demo", title="ghoul demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
