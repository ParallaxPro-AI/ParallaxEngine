from parallax import Model, vec3
from parallax.test import playtest
from project import Placed, Scenes


@playtest("spin turns the fan a quarter turn in a quarter period; oscillate stays in its range")
async def test_spin_and_oscillate(game):
    await game.start(scene=Scenes.yard)
    model = game.world.placed(Placed.gadget).get(Model)
    await game.advance(seconds=0.5)
    assert 80 < model.joint("fan") < 100
    lows, highs = 1.0, -1.0
    for _ in range(20):
        await game.advance(seconds=0.1)
        lows = min(lows, model.joint("lid"))
        highs = max(highs, model.joint("lid"))
    assert lows < 0.02 and 0.18 < highs <= 0.2


@playtest("the hatch opens while a visitor is near and closes when it leaves")
async def test_proximity(game):
    await game.start(scene=Scenes.yard)
    gadget = game.world.placed(Placed.gadget)
    visitor = game.world.placed(Placed.visitor)
    await game.advance(seconds=0.3)
    assert gadget.get(Model).joint("hatch") == 0
    visitor.transform.position = vec3(1.5, 0.5, 0)
    await game.advance(seconds=0.8)
    assert gadget.get(Model).joint("hatch") > 99
    visitor.transform.position = vec3(9, 0.5, 0)
    await game.advance(seconds=0.8)
    assert gadget.get(Model).joint("hatch") < 1
