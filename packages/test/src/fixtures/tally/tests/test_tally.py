from parallax import Camera, vec2, vec3
from parallax.test import playtest
from project import Scenes

from game.actions import Controls
from game.events import Bumped
from game.resources import Tally
from game.ui import Board, PauseMenu, StartMenu
from tests.helpers import bump_times, into_arena


@playtest("the start scene comes from the game unless the test picks one")
async def test_start_scene(game):
    await game.start()
    assert game.is_open(StartMenu)
    await game.click(StartMenu, "play")
    await game.advance(frames=1)
    assert game.is_open(Board)


@playtest("press is one frame: it counts once")
async def test_press(game):
    await into_arena(game)
    await game.press(Controls.bump)
    assert game.get(Tally).value == 1
    assert game.get(Tally).held_frames == 0
    assert game.get(Tally).releases == 1
    await bump_times(game, 2)
    assert game.get(Tally).value == 3


@playtest("hold keeps a button down for whole frames: one press, one release")
async def test_hold(game):
    await into_arena(game)
    await game.hold(Controls.bump, seconds=0.5)
    assert game.get(Tally).value == 1
    assert game.get(Tally).held_frames == 30
    assert game.get(Tally).releases == 0
    await game.advance(frames=3)
    assert game.get(Tally).held_frames == 30
    assert game.get(Tally).releases == 1


@playtest("hold without seconds stays down while other actions run; release lets go")
async def test_hold_while_moving(game):
    await into_arena(game)
    await game.hold(Controls.bump)
    await game.move(Controls.steer, vec2(1, 0), seconds=0.5)
    await game.press_index(Controls.lanes, 1)
    tally = game.get(Tally)
    assert tally.value == 1 and tally.held_frames == 31 and tally.releases == 0
    assert abs(tally.steered - 0.5) < 1e-9 and tally.lane == 1
    await game.move(Controls.steer, vec2(-1, 0))
    await game.advance(frames=30)
    assert abs(tally.steered) < 1e-9
    await game.release(Controls.steer)
    await game.release(Controls.bump)
    assert tally.releases == 1 and tally.held_frames == 62
    await game.advance(frames=3)
    assert abs(tally.steered) < 1e-9


@playtest("2D: position += vec2 moves x and y and keeps z; mixing types otherwise is a TypeError")
async def test_vec2_position(game):
    await into_arena(game)
    camera, _ = game.world.query(Camera).first()
    camera.transform.position = vec3(1, 2, 5)
    camera.transform.position += vec2(1, 0)
    camera.transform.position -= vec2(0, 2)
    assert camera.transform.position == vec3(2, 0, 5)
    assert vec2(1, 1) + vec3(1, 2, 3) == vec3(2, 3, 3)
    try:
        vec2(1, 0) * vec2(1, 0)
        raised = False
    except TypeError:
        raised = True
    assert raised


@playtest("axes and groups")
async def test_axes(game):
    await into_arena(game)
    await game.move(Controls.steer, vec2(1, 0), seconds=1)
    assert abs(game.get(Tally).steered - 1.0) < 1e-9
    await game.set_axis(Controls.throttle, 0.5, seconds=0.1)
    assert game.get(Tally).throttle == 0.5
    await game.advance(frames=1)
    assert game.get(Tally).throttle == 0
    await game.press_index(Controls.lanes, 2)
    assert game.get(Tally).lane == 2


@playtest("events: until returns the next one, emitted keeps them all")
async def test_events(game):
    await into_arena(game)
    game.ctx.get(Tally).value = 10
    await game.press(Controls.bump)
    bumped = game.emitted(Bumped)
    assert len(bumped) == 1 and bumped[0].total == 11
    await game.press(Controls.bump)
    assert [e.total for e in game.emitted(Bumped)] == [11, 12]


@playtest("panels: click with data, read their state, modal pause")
async def test_panels(game):
    await into_arena(game)
    await game.click(Board, "add", amount=5)
    await game.advance(frames=1)
    assert game.panel_state(Board)["value"] == 5
    await game.press(Controls.pause)
    assert game.is_open(PauseMenu)
    await game.press(Controls.bump)
    assert game.get(Tally).value == 5
    await game.click(PauseMenu, "resume")
    assert not game.is_open(PauseMenu)


@playtest("advance_until stops as soon as the condition holds")
async def test_advance_until(game):
    await into_arena(game)
    start = game.ctx.time.frame
    await game.advance_until(lambda: game.ctx.time.frame >= start + 7)
    assert game.ctx.time.frame == start + 7


@playtest("pointer and text")
async def test_pointer_and_text(game):
    await into_arena(game)
    await game.tap(vec2(320, 200))
    assert game.get(Tally).tap_x == 320
    await game.tap_world(vec2(0, 0))
    assert game.get(Tally).tap_x == 640
    await game.tap_world(vec2(3, 0))
    assert abs(game.get(Tally).tap_world_x - 3) < 1e-9
    await game.type_text("hi")
    assert game.get(Tally).typed == "hi"


@playtest("print output is captured")
async def test_print(game):
    print("before start")
    await into_arena(game)
    await game.press(Controls.bump)
