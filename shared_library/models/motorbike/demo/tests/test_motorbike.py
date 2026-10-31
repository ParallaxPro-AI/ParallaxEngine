from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("motorbike: the prefab spawns and its model's controls work")
async def test_motorbike(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.motorbike, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("steer", 0.0)
    assert abs(model.joint("steer") - 0.0) < 1e-3
    model.set_option("style", "cruiser")
    assert model.option("style") == "cruiser"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 3.72
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
