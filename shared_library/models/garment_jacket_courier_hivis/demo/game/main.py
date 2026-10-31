"""Demo host for the garment_jacket_courier_hivis model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="garment_jacket_courier_hivis_demo", title="garment_jacket_courier_hivis demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
