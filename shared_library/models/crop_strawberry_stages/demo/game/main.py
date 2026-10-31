"""Demo host for the crop_strawberry_stages model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="crop_strawberry_stages_demo", title="crop_strawberry_stages demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
