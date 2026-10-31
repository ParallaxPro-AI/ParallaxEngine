from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("butter_churn: the prefab spawns and its model's controls work")
async def test_butter_churn(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.butter_churn, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("dasher", 0.1)
    assert abs(model.joint("dasher") - 0.1) < 1e-3
    model.set_option("wood", "oak")
    assert model.option("wood") == "oak"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
