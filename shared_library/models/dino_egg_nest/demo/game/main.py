"""Demo host for the dino_egg_nest model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="dino_egg_nest_demo", title="dino_egg_nest demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
