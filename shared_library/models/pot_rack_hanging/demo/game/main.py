"""Demo host for the pot_rack_hanging model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="pot_rack_hanging_demo", title="pot_rack_hanging demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
