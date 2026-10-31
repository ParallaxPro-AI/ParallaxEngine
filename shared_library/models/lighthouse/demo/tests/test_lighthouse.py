from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("lighthouse: the prefab spawns and its model's controls work")
async def test_lighthouse(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.lighthouse, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door", 50.0)
    assert abs(model.joint("door") - 50.0) < 1e-3
    model.set_option("bands_colour", "black")
    assert model.option("bands_colour") == "black"
    assert model.socket_position("socket_light").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
