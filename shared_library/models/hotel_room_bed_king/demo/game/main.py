"""Demo host for the hotel_room_bed_king model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="hotel_room_bed_king_demo", title="hotel_room_bed_king demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
