from parallax.test import playtest
from project import Scenes

from game.lib.save_slots import SaveSlots
from game.main import DemoRun


@playtest("save a slot in a level, change the run, load it back")
async def test_save_and_load(game):
    await game.start(scene=Scenes.level)
    await game.advance(seconds=2)
    game.get(DemoRun).coins = 5
    game.ctx.ui.open(SaveSlots)
    await game.advance(frames=1)
    await game.click(SaveSlots, "save", slot="slot_2")
    await game.advance(frames=1)
    row = game.panel_state(SaveSlots)["slots"][1]
    assert row["used"] and row["scene"] == "level" and row["latest"] and row["play_seconds"] > 1.9
    assert not game.panel_state(SaveSlots)["slots"][0]["used"]
    info = game.ctx.save.info("slot_2")
    assert info.scene == Scenes.level and info.saved_at is None and info.order == 1
    await game.click(SaveSlots, "save", slot="slot_1")
    await game.advance(frames=1)
    rows = game.panel_state(SaveSlots)["slots"]
    assert rows[0]["latest"] and not rows[1]["latest"]
    game.get(DemoRun).coins = 9
    await game.click(SaveSlots, "load", slot="slot_2")
    await game.advance(frames=3)
    assert game.get(DemoRun).coins == 5
    assert not game.is_open(SaveSlots)


@playtest("the title can load and delete but not save")
async def test_title(game):
    await game.start(scene=Scenes.level)
    game.get(DemoRun).coins = 3
    game.ctx.ui.open(SaveSlots)
    await game.advance(frames=1)
    await game.click(SaveSlots, "save", slot="slot_1")
    await game.advance(frames=1)
    game.ctx.scenes.load(Scenes.title, new_run=True)
    await game.advance(frames=2)
    game.ctx.ui.open(SaveSlots)
    await game.advance(frames=1)
    state = game.panel_state(SaveSlots)
    assert not state["can_save"] and state["slots"][0]["used"]
    await game.click(SaveSlots, "delete", slot="slot_1")
    await game.advance(frames=1)
    assert not game.panel_state(SaveSlots)["slots"][0]["used"]
