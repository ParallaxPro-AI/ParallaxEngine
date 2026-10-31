"""Demo host for the residential_mailbox model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="residential_mailbox_demo", title="residential_mailbox demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
