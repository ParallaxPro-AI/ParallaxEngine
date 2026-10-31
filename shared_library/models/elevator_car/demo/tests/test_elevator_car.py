from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("elevator_car: the prefab spawns and its model's controls work")
async def test_elevator_car(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.elevator_car, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_l", 0.22)
    assert abs(model.joint("door_l") - 0.22) < 1e-3
    model.set_option("interior", "brass")
    assert model.option("interior") == "brass"
    assert model.socket_position("socket_floor").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
