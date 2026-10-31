"""Demo host for the mushroom_giant_fantasy model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="mushroom_giant_fantasy_demo", title="mushroom_giant_fantasy demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
