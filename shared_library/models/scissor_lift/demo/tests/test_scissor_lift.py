from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("scissor_lift: the prefab spawns and its model's controls work")
async def test_scissor_lift(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.scissor_lift, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lift_0", 0.2883)
    assert abs(model.joint("lift_0") - 0.2883) < 1e-3
    model.set_option("paint", "orange")
    assert model.option("paint") == "orange"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
