"""Demo host for the farm_mailbox_shipping_bin model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="farm_mailbox_shipping_bin_demo", title="farm_mailbox_shipping_bin demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
