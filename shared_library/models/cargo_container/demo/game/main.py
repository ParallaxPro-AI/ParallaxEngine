"""Demo host for the cargo_container model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="cargo_container_demo", title="cargo_container demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
