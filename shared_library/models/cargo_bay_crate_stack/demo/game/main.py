"""Demo host for the cargo_bay_crate_stack model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="cargo_bay_crate_stack_demo", title="cargo_bay_crate_stack demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
