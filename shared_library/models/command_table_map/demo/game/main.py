"""Demo host for the command_table_map model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="command_table_map_demo", title="command_table_map demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
