from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("house_window_shutters: the prefab spawns and its model's controls work")
async def test_house_window_shutters(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.house_window_shutters, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("leaf_l", 90.0)
    assert abs(model.joint("leaf_l") - 90.0) < 1e-3
    model.set_option("style", "panelled")
    assert model.option("style") == "panelled"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
