from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("crane: the prefab spawns and its model's controls work")
async def test_crane(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.crane, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("jib", 27.5)
    assert abs(model.joint("jib") - 27.5) < 1e-3
    model.set_option("config", "mobile")
    assert model.option("config") == "mobile"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
