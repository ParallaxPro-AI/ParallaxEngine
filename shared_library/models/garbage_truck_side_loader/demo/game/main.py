"""Demo host for the garbage_truck_side_loader model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d, vehicles
from project import Scenes

game = Game(id="garbage_truck_side_loader_demo", title="garbage_truck_side_loader demo", sdk="1.0", mode="3d",
            plugins=[physics3d(), vehicles()], start_scene=Scenes.yard)
