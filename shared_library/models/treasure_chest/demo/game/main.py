"""Demo host for the treasure_chest model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="treasure_chest_demo", title="treasure_chest demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
