from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bucket: the prefab spawns and its model's controls work")
async def test_bucket(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bucket, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("bail", 0.0)
    assert abs(model.joint("bail") - 0.0) < 1e-3
    model.set_option("contents", "water")
    assert model.option("contents") == "water"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
