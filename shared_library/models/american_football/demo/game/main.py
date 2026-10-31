"""Demo host for the american_football model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="american_football_demo", title="american_football demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
