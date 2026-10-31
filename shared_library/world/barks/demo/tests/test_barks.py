from parallax import vec3
from parallax.combat import Health
from parallax.test import playtest
from project import Placed, Scenes

from game.lib.barks import BarkRequested, BarkSaid


@playtest("a requested bark says one of the voice's lines; the speaker's cooldown holds the next")
async def test_requested(game):
    await game.start(scene=Scenes.town)
    guard = game.world.placed(Placed.guard)
    game.ctx.emit(BarkRequested(speaker=guard, trigger="spotted"))
    await game.advance(frames=2)
    said = game.emitted(BarkSaid)
    assert len(said) == 1 and said[0].text in ("Hey! You there!", "Stop right there!", "Intruder!")
    game.ctx.emit(BarkRequested(speaker=guard, trigger="spotted"))
    await game.advance(seconds=2)
    assert len(game.emitted(BarkSaid)) == 1
    await game.advance(seconds=1.5)
    game.ctx.emit(BarkRequested(speaker=guard, trigger="spotted"))
    await game.advance(frames=2)
    said = game.emitted(BarkSaid)
    assert len(said) == 2 and said[1].text != said[0].text


@playtest("damage makes a barker bark its hurt line; a voice without the trigger stays quiet")
async def test_hurt(game):
    await game.start(scene=Scenes.town)
    game.world.placed(Placed.guard).get(Health).damage(5)
    await game.advance(frames=2)
    assert [s.text for s in game.emitted(BarkSaid)] == ["Argh!"]
    await game.advance(seconds=1.2)
    game.world.placed(Placed.villager).get(Health).damage(5)
    await game.advance(frames=2)
    assert len(game.emitted(BarkSaid)) == 1


@playtest("walking up to a villager triggers its near line once")
async def test_near(game):
    await game.start(scene=Scenes.town)
    hero = game.world.placed(Placed.hero)
    hero.transform.position = vec3(9, 0, 0)
    await game.advance(seconds=1)
    hero.transform.position = vec3(9.5, 0, 0)
    await game.advance(seconds=3)
    said = game.emitted(BarkSaid)
    assert len(said) == 1 and said[0].speaker == game.world.placed(Placed.villager)
