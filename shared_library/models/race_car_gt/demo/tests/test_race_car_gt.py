from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("race_car_gt: the prefab spawns and its model's controls work")
async def test_race_car_gt(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.race_car_gt, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_l", 34.0)
    assert abs(model.joint("door_l") - 34.0) < 1e-3
    model.set_option("livery", "red")
    assert model.option("livery") == "red"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
