from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("milk_churn: the prefab spawns and its model's controls work")
async def test_milk_churn(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.milk_churn, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lid", 0.08)
    assert abs(model.joint("lid") - 0.08) < 1e-3
    model.set_option("contents", "empty")
    assert model.option("contents") == "empty"
    await game.advance(seconds=1)
