from parallax.test import playtest
from project import Placed, Scenes

from game.lib.ghost_racer import GhostRecords, GhostTake
from game.lib.time_trial import FinishReached, TrialFinished


@playtest("no ghost on the first attempt; the run is sampled at the recorder's rate")
async def test_record(game):
    await game.start(scene=Scenes.canyon)
    await game.advance(seconds=2)
    assert not game.world.placed(Placed.ghost).visible
    samples = game.get(GhostTake).samples
    assert 19 <= len(samples) <= 21
    assert 0.09 < samples[2].time - samples[1].time < 0.11


@playtest("a best run is kept and its ghost replays it on the next attempt")
async def test_replay(game):
    await game.start(scene=Scenes.canyon)
    await game.advance(seconds=3)
    game.ctx.emit(FinishReached())
    await game.until(TrialFinished)
    best = game.get(GhostRecords).best["canyon_run"]
    assert 2.9 < best.seconds < 3.1 and len(best.samples) >= 29
    game.ctx.scenes.reload(new_run=True)
    await game.advance(seconds=1.5)
    ghost = game.world.placed(Placed.ghost)
    runner = game.world.placed(Placed.runner)
    assert ghost.visible
    assert abs(ghost.transform.position.x - runner.transform.position.x) < 0.25
    await game.advance(seconds=2)
    assert not ghost.visible


@playtest("a slower run does not replace the ghost")
async def test_slower(game):
    await game.start(scene=Scenes.canyon)
    await game.advance(seconds=2)
    game.ctx.emit(FinishReached())
    await game.until(TrialFinished)
    game.ctx.scenes.reload(new_run=True)
    await game.advance(seconds=4)
    game.ctx.emit(FinishReached())
    finished = await game.until(TrialFinished)
    assert not finished.new_best
    assert game.get(GhostRecords).best["canyon_run"].seconds < 2.1


@playtest("a variant keys its own ghost: a best under one variant never ghosts another")
async def test_variant(game):
    from game.lib.time_trial import TrialRun
    await game.start(scene=Scenes.canyon)
    game.get(TrialRun).variant = "2"
    await game.advance(seconds=2)
    game.ctx.emit(FinishReached())
    finished = await game.until(TrialFinished)
    assert finished.key == "canyon_run:2"
    assert "canyon_run:2" in game.get(GhostRecords).best and "canyon_run" not in game.get(GhostRecords).best
    game.ctx.scenes.reload(new_run=True)
    game.get(TrialRun).variant = "3"
    await game.advance(seconds=1)
    assert not game.world.placed(Placed.ghost).visible
