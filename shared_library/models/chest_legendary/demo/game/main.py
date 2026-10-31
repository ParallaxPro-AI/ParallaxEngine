"""Demo host for the chest_legendary model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="chest_legendary_demo", title="chest_legendary demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
