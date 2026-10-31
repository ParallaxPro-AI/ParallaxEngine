from parallax import Model, vec3
from parallax.physics import Rigidbody
from parallax.vehicles import Vehicle
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("hatchback: the prefab spawns and its model's controls work")
async def test_hatchback(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.hatchback, at=vec3(0, 1.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_fl", 33.0)
    assert abs(model.joint("door_fl") - 33.0) < 1e-3
    model.set_option("paint", "teal")
    assert model.option("paint") == "teal"
    assert model.socket_position("eye_point").distance_to(thing.transform.position) < 6.8
    await game.advance(seconds=4)
    assert thing.transform.position.y < 1.0
    assert thing.get(Rigidbody).velocity.length() < 0.5
    # Driving rolls the wheels and steers the front ones (vehicle_rig).
    for _ in range(30):
        thing.get(Vehicle).drive(throttle=1, steer=1)
        await game.advance(frames=1)
    assert model.joint("wheel_f_l_roll") != 0
    assert model.joint("wheel_f_l_steer") > 0
