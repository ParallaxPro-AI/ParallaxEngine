from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("motorhome: the prefab spawns and its model's controls work")
async def test_motorhome(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.motorhome, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("side_door", 50.0)
    assert abs(model.joint("side_door") - 50.0) < 1e-3
    model.set_option("config", "solar")
    assert model.option("config") == "solar"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
