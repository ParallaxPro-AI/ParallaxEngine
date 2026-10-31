"""Demo host for map_screen: an explorer on an island."""

from parallax import Game
from parallax.plugins import hud
from project import Scenes

from game.lib.map_screen import MapZoom

game = Game(id="map_screen_demo", title="Map screen demo", sdk="1.0", mode="3d",
            plugins=[hud()], systems=[MapZoom], start_scene=Scenes.island)
