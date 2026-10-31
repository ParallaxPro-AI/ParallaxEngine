"""Demo host for the morgue_tag_body_bag model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="morgue_tag_body_bag_demo", title="morgue_tag_body_bag demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
