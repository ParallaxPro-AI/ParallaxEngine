from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("flashlight: the prefab spawns and its model's controls work")
async def test_flashlight(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.flashlight, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("switch", 0.0006)
    assert abs(model.joint("switch") - 0.0006) < 1e-3
    model.set_option("power", "on")
    assert model.option("power") == "on"
    assert model.socket_position("beam").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
