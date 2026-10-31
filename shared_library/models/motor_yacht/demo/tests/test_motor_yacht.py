from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("motor_yacht: the prefab spawns and its model's controls work")
async def test_motor_yacht(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.motor_yacht, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_l", 50.0)
    assert abs(model.joint("door_l") - 50.0) < 1e-3
    assert model.socket_position("eye_point").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
