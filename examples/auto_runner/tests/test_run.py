"""Playtests for a run down the canyon."""

from parallax.combat import Health
from parallax.test import GameHarness, playtest
from project import Scenes

from game.actions import Controls
from game.components import Hopper, Runner
from game.config import Canyon
from game.events import HazardPlaced, RunEnded
from game.resources import Profile, Run
from game.systems.feed import airtime
from game.ui import FarRim, PauseMenu, TitleScreen, WipedOut


@playtest("journey starts from the title screen with full hearts")
async def test_start(game: GameHarness):
    await game.start(scene=Scenes.title)
    await game.click(TitleScreen, "play", endless=False)
    await game.advance(frames=2)
    assert game.ctx.scenes.current_is(Scenes.canyon)
    assert not game.get(Run).endless
    _, health = game.world.query(Health, tagged=Runner).single()
    assert health.current == health.max


@playtest("a runner that never hops is wiped out and the run is banked")
async def test_wipeout(game: GameHarness):
    await game.start(scene=Scenes.canyon)
    await game.advance_until(lambda: game.is_open(WipedOut), timeout=30)
    run = game.get(Run)
    assert not run.won and run.killer is not None
    assert game.get(Profile).best_journey == int(run.distance)
    assert len(game.emitted(RunEnded)) == 1


@playtest("every gap leaves room for a full hop plus a reaction")
async def test_gaps_are_clearable(game: GameHarness):
    await game.start(scene=Scenes.canyon, seed=7)
    await game.advance_until(lambda: game.is_open(WipedOut), timeout=30)
    cfg = game.config(Canyon)
    _, hopper = game.world.query(Hopper).single()
    # The world never runs slower than base speed, so this is a lower bound on every gap.
    shortest = max(cfg.floor_distance, (airtime(hopper) + cfg.min_react_time) * cfg.base_speed)
    for placed in game.emitted(HazardPlaced)[cfg.seed_hazards:]:
        assert placed.gap >= shortest


@playtest("quitting from the pause menu still banks the half-run")
async def test_quit_banks(game: GameHarness):
    await game.start(scene=Scenes.canyon)
    await game.advance(seconds=2)
    await game.press(Controls.pause)
    distance = int(game.get(Run).distance)
    await game.click(PauseMenu, "quit")
    await game.advance(frames=2)
    assert game.ctx.scenes.current_is(Scenes.title)
    assert game.get(Profile).best_journey == distance


@playtest("pause freezes the run and the pause key resumes it, but not on the title")
async def test_pause(game: GameHarness):
    await game.start(scene=Scenes.title)
    await game.press(Controls.pause)
    assert not game.is_open(PauseMenu)
    await game.click(TitleScreen, "play", endless=False)
    await game.advance(seconds=1)
    await game.press(Controls.pause)
    assert game.is_open(PauseMenu)
    distance = game.get(Run).distance
    await game.advance(seconds=2)
    assert game.get(Run).distance == distance
    await game.press(Controls.pause)
    assert not game.is_open(PauseMenu)


@playtest("retry resets the run but keeps the profile and the mode")
async def test_retry(game: GameHarness):
    await game.start(scene=Scenes.canyon)
    game.get(Run).endless = True
    await game.advance_until(lambda: game.is_open(WipedOut), timeout=30)
    wallet = game.get(Profile).wallet
    await game.click(WipedOut, "retry")
    await game.advance(frames=2)
    assert game.get(Run).distance < 1
    assert game.get(Run).endless
    assert game.get(Profile).wallet == wallet


@playtest("a hop leaves the ground and lands back on it")
async def test_hop(game: GameHarness):
    await game.start(scene=Scenes.canyon)
    runner = game.world.query(Hopper).single()[0]
    rest = runner.transform.position.y
    await game.press(Controls.hop)
    await game.advance(seconds=0.2)
    assert runner.transform.position.y > rest + 1
    await game.advance(seconds=0.5)
    assert abs(runner.transform.position.y - rest) < 1e-6


@playtest("reaching the far rim wins the journey, unlocks Endless and offers it")
async def test_reach_the_rim(game: GameHarness):
    await game.start(scene=Scenes.canyon)
    run = game.get(Run)
    run.distance = game.config(Canyon).goal_distance - 1
    ended = await game.until(RunEnded)
    assert ended.won
    assert game.get(Profile).endless_unlocked
    await game.advance_until(lambda: game.is_open(FarRim))
    assert not game.is_open(WipedOut)
    await game.click(FarRim, "endless", endless=True)
    await game.advance(frames=2)
    assert game.get(Run).endless and game.get(Run).distance < 1
