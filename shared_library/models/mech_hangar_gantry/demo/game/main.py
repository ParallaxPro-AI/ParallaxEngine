"""Demo host for the mech_hangar_gantry model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="mech_hangar_gantry_demo", title="mech_hangar_gantry demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
