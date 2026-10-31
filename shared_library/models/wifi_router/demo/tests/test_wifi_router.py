from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("wifi_router: the prefab spawns and its model's controls work")
async def test_wifi_router(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.wifi_router, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("antenna_0", 44.0)
    assert abs(model.joint("antenna_0") - 44.0) < 1e-3
    model.set_option("colour", "black")
    assert model.option("colour") == "black"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
