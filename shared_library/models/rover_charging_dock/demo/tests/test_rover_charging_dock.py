from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("rover_charging_dock: the prefab spawns and its model's controls work")
async def test_rover_charging_dock(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.rover_charging_dock, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("arm_yaw", 0.0)
    assert abs(model.joint("arm_yaw") - 0.0) < 1e-3
    model.set_option("hull", "grey")
    assert model.option("hull") == "grey"
    assert model.socket_position("plug").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
