from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("snowmobile: the prefab spawns and its model's controls work")
async def test_snowmobile(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.snowmobile, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("ski_steer_l", 0.0)
    assert abs(model.joint("ski_steer_l") - 0.0) < 1e-3
    model.set_option("paint", "red")
    assert model.option("paint") == "red"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
