from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("delivery_van_electric: the prefab spawns and its model's controls work")
async def test_delivery_van_electric(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.delivery_van_electric, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("side_door", 0.65)
    assert abs(model.joint("side_door") - 0.65) < 1e-3
    model.set_option("config", "window")
    assert model.option("config") == "window"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
