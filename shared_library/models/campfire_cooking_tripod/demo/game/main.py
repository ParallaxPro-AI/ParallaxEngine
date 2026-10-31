"""Demo host for the campfire_cooking_tripod model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="campfire_cooking_tripod_demo", title="campfire_cooking_tripod demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
