"""Demo host for the spaceship_cockpit_seat model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="spaceship_cockpit_seat_demo", title="spaceship_cockpit_seat demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
