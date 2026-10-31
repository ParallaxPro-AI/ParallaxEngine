"""Demo host for the garment_head_hood_cowl model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="garment_head_hood_cowl_demo", title="garment_head_hood_cowl demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
