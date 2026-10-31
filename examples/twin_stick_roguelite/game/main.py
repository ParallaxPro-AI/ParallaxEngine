"""Cellar Purge: a twin-stick roguelite. Four floors, four bosses, one vault."""

from parallax import Game
from parallax.plugins import characters, cinematics, combat, hud, nav, physics3d
from project import Scenes

from game.actions import CutsceneControls
from game.components import Layers
from game.systems.floor_builder import FloorBuilder
from game.systems.relic_draft import RelicDraft
from game.systems.room_director import RoomDirector
from game.systems.run_flow import RunFlow
from game.systems.spoils import Spoils
from game.systems.vault_keeper import VaultKeeper

game = Game(
    id="twin_stick_roguelite",
    title="Cellar Purge",
    sdk="1.0",
    mode="3d",
    start_scene=Scenes.title,
    plugins=[physics3d(layers=Layers), characters(), combat(), nav(), hud(),
             cinematics(skip=CutsceneControls.skip)],
    systems=[RunFlow, FloorBuilder, RoomDirector, Spoils, RelicDraft, VaultKeeper],
)
