from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("teapot: the prefab spawns and its model's controls work")
async def test_teapot(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.teapot, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lid", 0.035)
    assert abs(model.joint("lid") - 0.035) < 1e-3
    model.set_option("glaze", "white")
    assert model.option("glaze") == "white"
    assert model.socket_position("socket_lid_top").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
