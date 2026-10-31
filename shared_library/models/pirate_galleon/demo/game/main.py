"""Demo host for the pirate_galleon model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="pirate_galleon_demo", title="pirate_galleon demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
