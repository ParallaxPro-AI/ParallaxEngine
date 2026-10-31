from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("moped: the prefab spawns and its model's controls work")
async def test_moped(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.moped, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("steer", 0.0)
    assert abs(model.joint("steer") - 0.0) < 1e-3
    model.set_option("type", "kick")
    assert model.option("type") == "kick"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
