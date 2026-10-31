"""Demo host for radial_menu: a weapon wheel."""

from parallax import Game
from project import Scenes

from game.lib.radial_menu import RadialSelection

game = Game(id="radial_menu_demo", title="Radial menu demo", sdk="1.0", mode="2d",
            systems=[RadialSelection], start_scene=Scenes.arena)
