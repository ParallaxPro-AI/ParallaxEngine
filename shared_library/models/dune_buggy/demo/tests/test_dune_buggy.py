from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("dune_buggy: the prefab spawns and its model's controls work")
async def test_dune_buggy(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.dune_buggy, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("wheel_f_l_steer", 0.0)
    assert abs(model.joint("wheel_f_l_steer") - 0.0) < 1e-3
    model.set_option("paint", "orange")
    assert model.option("paint") == "orange"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
