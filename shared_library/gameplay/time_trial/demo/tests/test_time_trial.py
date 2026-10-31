from parallax.test import playtest
from project import Content, Scenes

from game.lib.time_trial import FinishReached, Medal, TrialFinished, TrialRecords, TrialTimer


@playtest("the clock runs from the scene load; the line gives a medal and a best time")
async def test_run(game):
    await game.start(scene=Scenes.canyon)
    await game.advance(seconds=3)
    assert game.is_open(TrialTimer)
    assert 2.9 < game.panel_state(TrialTimer)["time"] < 3.1
    game.ctx.emit(FinishReached())
    done = await game.until(TrialFinished)
    assert done.medal == Medal.SILVER and done.new_best
    assert game.get(TrialRecords).best["canyon_run"] == done.seconds
    await game.advance(seconds=1)
    assert game.panel_state(TrialTimer)["time"] == done.seconds


@playtest("a slower retry keeps the best time and the best medal")
async def test_best_kept(game):
    await game.start(scene=Scenes.canyon)
    await game.advance(seconds=1.5)
    game.ctx.emit(FinishReached())
    first = await game.until(TrialFinished)
    assert first.medal == Medal.GOLD
    game.ctx.scenes.reload(new_run=True)
    await game.advance(seconds=5)
    game.ctx.emit(FinishReached())
    second = await game.until(TrialFinished)
    assert second.medal == Medal.BRONZE and not second.new_best
    assert second.best == first.seconds
    assert game.get(TrialRecords).medals[Content.trial.canyon_run.id] == Medal.GOLD


@playtest("a scene with no trial has no timer")
async def test_untimed(game):
    await game.start(scene=Scenes.meadow)
    await game.advance(seconds=1)
    assert not game.is_open(TrialTimer)
    game.ctx.emit(FinishReached())
    await game.advance(frames=2)
    assert game.emitted(TrialFinished) == []
