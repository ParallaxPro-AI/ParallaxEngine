"""Demo host for the fantasy_bridge_covered model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="fantasy_bridge_covered_demo", title="fantasy_bridge_covered demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
