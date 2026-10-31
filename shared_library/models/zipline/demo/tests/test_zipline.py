from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("zipline: the prefab spawns and its model's controls work")
async def test_zipline(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.zipline, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("trolley", 6.7279)
    assert abs(model.joint("trolley") - 6.7279) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
