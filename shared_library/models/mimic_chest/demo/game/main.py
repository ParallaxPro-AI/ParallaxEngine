"""Demo host for the mimic_chest model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="mimic_chest_demo", title="mimic_chest demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
