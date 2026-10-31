from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("double_decker_bus: the prefab spawns and its model's controls work")
async def test_double_decker_bus(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.double_decker_bus, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_f_a", 40.0)
    assert abs(model.joint("door_f_a") - 40.0) < 1e-3
    model.set_option("paint", "blue")
    assert model.option("paint") == "blue"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
