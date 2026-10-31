from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("gatehouse: the prefab spawns and its model's controls work")
async def test_gatehouse(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.gatehouse, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door", 50.0)
    assert abs(model.joint("door") - 50.0) < 1e-3
    model.set_option("brick", "buff")
    assert model.option("brick") == "buff"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
