from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("cargo_trike: the prefab spawns and its model's controls work")
async def test_cargo_trike(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.cargo_trike, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("steer", 0.0)
    assert abs(model.joint("steer") - 0.0) < 1e-3
    model.set_option("type", "kick")
    assert model.option("type") == "kick"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
