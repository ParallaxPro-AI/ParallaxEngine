"""Demo host for the coal_tender model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="coal_tender_demo", title="coal_tender demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
