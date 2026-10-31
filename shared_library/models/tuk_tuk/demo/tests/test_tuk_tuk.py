from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("tuk_tuk: the prefab spawns and its model's controls work")
async def test_tuk_tuk(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.tuk_tuk, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("steer_front", 0.0)
    assert abs(model.joint("steer_front") - 0.0) < 1e-3
    model.set_option("paint", "yellow")
    assert model.option("paint") == "yellow"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
