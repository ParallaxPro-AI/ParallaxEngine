from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("sports_car: the prefab spawns and its model's controls work")
async def test_sports_car(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.sports_car, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_l", 34.0)
    assert abs(model.joint("door_l") - 34.0) < 1e-3
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
