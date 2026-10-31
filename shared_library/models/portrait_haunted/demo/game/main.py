"""Demo host for the portrait_haunted model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="portrait_haunted_demo", title="portrait_haunted demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
