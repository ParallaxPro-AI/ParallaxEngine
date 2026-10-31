from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("robot_drone: the prefab spawns and its model's controls work")
async def test_robot_drone(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.robot_drone, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("sensor_eye", 0.0)
    assert abs(model.joint("sensor_eye") - 0.0) < 1e-3
    assert model.socket_position("socket_eye").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
