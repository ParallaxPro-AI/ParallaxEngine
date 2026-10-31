"""Demo host for the chest_common model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="chest_common_demo", title="chest_common demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
