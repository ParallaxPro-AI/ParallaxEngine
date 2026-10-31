"""Demo host for the ac_condenser_unit model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="ac_condenser_unit_demo", title="ac_condenser_unit demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
