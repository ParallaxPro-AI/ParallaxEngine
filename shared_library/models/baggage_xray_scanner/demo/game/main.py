"""Demo host for the baggage_xray_scanner model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="baggage_xray_scanner_demo", title="baggage_xray_scanner demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
