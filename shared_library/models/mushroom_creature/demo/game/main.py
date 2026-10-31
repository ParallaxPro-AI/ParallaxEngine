"""Demo host for the mushroom_creature model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="mushroom_creature_demo", title="mushroom_creature demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
