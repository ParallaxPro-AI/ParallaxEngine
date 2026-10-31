"""Demo host for the advent_calendar_house model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="advent_calendar_house_demo", title="advent_calendar_house demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
