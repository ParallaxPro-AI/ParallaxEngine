"""Demo host for the mugshot_height_wall model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="mugshot_height_wall_demo", title="mugshot_height_wall demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
