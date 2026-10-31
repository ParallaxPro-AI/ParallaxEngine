"""Demo host for the retro_handheld model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="retro_handheld_demo", title="retro_handheld demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
