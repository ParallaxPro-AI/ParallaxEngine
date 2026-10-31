"""Demo host for the moving_boxes_taped model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="moving_boxes_taped_demo", title="moving_boxes_taped demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
