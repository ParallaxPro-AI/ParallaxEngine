"""Demo host for the message_in_bottle model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="message_in_bottle_demo", title="message_in_bottle demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
