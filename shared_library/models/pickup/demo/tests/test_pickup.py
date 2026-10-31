from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("pickup: the prefab spawns and its model's controls work")
async def test_pickup(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.pickup, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_front_l", 35.0)
    assert abs(model.joint("door_front_l") - 35.0) < 1e-3
    model.set_option("cab", "single")
    assert model.option("cab") == "single"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 9.45
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
