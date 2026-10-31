"""Demo host for the crew_jelly model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="crew_jelly_demo", title="crew_jelly demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
