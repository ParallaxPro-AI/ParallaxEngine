from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("saxophone: the prefab spawns and its model's controls work")
async def test_saxophone(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.saxophone, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("key_1", 0.002)
    assert abs(model.joint("key_1") - 0.002) < 1e-3
    model.set_option("finish", "gold")
    assert model.option("finish") == "gold"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
