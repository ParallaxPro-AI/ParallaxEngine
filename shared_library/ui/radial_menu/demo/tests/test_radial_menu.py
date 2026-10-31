from parallax import vec2
from parallax.test import playtest
from project import Content, Scenes

from game.lib.radial_menu import RadialControls, RadialMenu, RadialPicked, RadialState, sector


def test_sectors_run_clockwise_from_the_top():
    assert sector(vec2(0, 1), 4) == 0
    assert sector(vec2(1, 0), 4) == 1
    assert sector(vec2(0, -1), 4) == 2
    assert sector(vec2(-1, 0), 4) == 3
    assert sector(vec2(0.2, 1), 4) == 0


@playtest("holding the key opens the wheel with the group's options in order")
async def test_wheel(game):
    await game.start(scene=Scenes.arena)
    await game.hold(RadialControls.wheel)
    await game.advance(frames=2)
    assert game.is_open(RadialMenu)
    assert [s["option"] for s in game.panel_state(RadialMenu)["slots"]] == ["pistol", "rifle", "grenade", "knife"]
    await game.release(RadialControls.wheel)
    await game.advance(frames=1)
    assert not game.is_open(RadialMenu)


@playtest("aiming while held highlights a sector; letting go picks it, with none nothing happens")
async def test_release(game):
    await game.start(scene=Scenes.arena)
    await game.hold(RadialControls.wheel, seconds=0.2)
    await game.advance(frames=2)
    assert game.emitted(RadialPicked) == []
    await game.hold(RadialControls.wheel)
    await game.move(RadialControls.aim, vec2(0, -1), seconds=0.1)
    assert game.get(RadialState).highlight == 2
    assert [s["option"] for s in game.panel_state(RadialMenu)["slots"] if s["lit"]] == ["grenade"]
    await game.release(RadialControls.wheel)
    picked = game.emitted(RadialPicked)
    assert len(picked) == 1 and picked[0].option == Content.radial_option.grenade and picked[0].group == "weapons"
    assert game.get(RadialState).highlight == -1


@playtest("the aim stick highlights only while the wheel is held")
async def test_aim(game):
    await game.start(scene=Scenes.arena)
    await game.move(RadialControls.aim, vec2(1, 0), seconds=0.2)
    assert game.get(RadialState).highlight == -1
