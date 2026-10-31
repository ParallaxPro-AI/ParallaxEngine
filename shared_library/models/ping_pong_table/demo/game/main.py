"""Demo host for the ping_pong_table model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="ping_pong_table_demo", title="ping_pong_table demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
