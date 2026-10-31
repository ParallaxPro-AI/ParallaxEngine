from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("crab: the prefab spawns and its model's controls work")
async def test_crab(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.crab, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("pinch_l", 16.0)
    assert abs(model.joint("pinch_l") - 16.0) < 1e-3
    model.set_option("shell", "red")
    assert model.option("shell") == "red"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
