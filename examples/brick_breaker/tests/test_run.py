from parallax import vec3
from parallax.combat import Health
from parallax.physics import Rigidbody
from parallax.test import playtest
from project import Content, Scenes

from game.actions import Controls, ServeControls
from game.components import Brick, Orb
from game.resources import Best, Mods, Run
from game.events import BallReturned, RailHit
from game.ui import DraftPanel, GameOverPanel, Hud, PauseMenu, TitleScreen


@playtest("Launch on the title screen starts stage 1 with the orb resting on the paddle")
async def test_title_to_arena(game):
    await game.start(scene=Scenes.title)
    await game.click(TitleScreen, "start")
    await game.advance(frames=2)
    assert game.ctx.scenes.current_is(Scenes.arena)
    hud = game.panel_state(Hud)
    assert hud["serving"] and hud["orbs"] == 3 and hud["bricks_left"] == 27
    assert [s["now"] for s in hud["segments"]] == [True, False, False, False, False]


async def aim_orb(game, at, velocity):
    """Launch, then put the orb at `at` moving with `velocity`."""
    await game.press(ServeControls.launch)
    await game.advance(frames=1)
    body = game.world.query(tagged=Orb).single().get(Rigidbody)
    body.teleport(at)
    body.velocity = velocity
    return body


@playtest("the orb bounces off a side rail and keeps its speed")
async def test_rail_bounce(game):
    await game.start(scene=Scenes.arena, seed=11)
    body = await aim_orb(game, vec3(8, 0.6, -3), vec3(6, 0, 3))
    await game.until(RailHit, timeout=2)
    await game.advance(frames=2)
    assert body.velocity.x < 0
    assert abs(body.velocity.length() - 9) < 0.01


@playtest("the paddle sends the orb back up the board, a little faster")
async def test_paddle_return(game):
    await game.start(scene=Scenes.arena, seed=12)
    body = await aim_orb(game, vec3(0.3, 0.6, -4.5), vec3(0, 0, -9))
    await game.until(BallReturned, timeout=2)
    await game.advance(frames=2)
    assert body.velocity.z > 0 and body.velocity.x > 0  # right of centre kicks right
    assert abs(body.velocity.length() - 9.25) < 0.01


@playtest("launching the orb cracks a brick")
async def test_launch_scores(game):
    await game.start(scene=Scenes.arena, seed=42)
    await game.press(ServeControls.launch)
    await game.advance_until(lambda: game.get(Run).score > 0, timeout=10)
    assert game.get(Run).combo >= 1


@playtest("the orb serves itself after the delay")
async def test_auto_serve(game):
    await game.start(scene=Scenes.arena, seed=1)
    assert game.get(Run).serving
    await game.advance(seconds=2.5)
    assert not game.get(Run).serving


@playtest("clearing a stage drafts an upgrade and starts the next stage")
async def test_stage_clear(game):
    await game.start(scene=Scenes.arena, seed=3)
    for brick in game.world.query(tagged=Brick):
        brick.get(Health).kill()
    await game.advance(frames=2)
    assert game.is_open(DraftPanel)
    assert game.panel_state(DraftPanel)["next_stage"] == "Spectrum"

    await game.click(DraftPanel, "pick", upgrade=Content.upgrade.wide.id)
    await game.advance(frames=2)
    assert not game.is_open(DraftPanel)
    assert game.get(Mods).paddle_width == 1.4
    assert game.get(Run).stage_index == 1
    assert game.world.query(tagged=Brick).count() == game.get(Run).bricks_left == 23


@playtest("dropping every orb ends the run, and retry keeps the best score")
async def test_game_over_and_retry(game):
    await game.start(scene=Scenes.arena, seed=5)
    await game.set_axis(Controls.steer, -1, seconds=1)
    await game.advance_until(lambda: game.is_open(GameOverPanel), timeout=180)
    assert not game.get(Run).won
    best = game.get(Best).score

    await game.click(GameOverPanel, "retry")
    await game.advance(frames=2)
    assert not game.is_open(GameOverPanel)
    assert game.get(Run).score == 0 and game.get(Run).balls_lost == 0
    assert game.get(Best).score == best


@playtest("the pause key opens and closes the pause menu, which freezes the board")
async def test_pause(game):
    await game.start(scene=Scenes.arena, seed=1)
    await game.press(ServeControls.launch)
    await game.press(Controls.pause)
    assert game.is_open(PauseMenu)
    before = game.get(Run).score
    await game.advance(seconds=3)
    assert game.get(Run).score == before
    await game.press(Controls.pause)
    assert not game.is_open(PauseMenu)


@playtest("there is no pause menu on the title screen")
async def test_no_pause_on_title(game):
    await game.start(scene=Scenes.title)
    await game.press(Controls.pause)
    assert not game.is_open(PauseMenu)
