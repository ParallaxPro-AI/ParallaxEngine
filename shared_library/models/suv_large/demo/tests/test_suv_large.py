from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("suv_large: the prefab spawns and its model's controls work")
async def test_suv_large(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.suv_large, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_f_l", 34.0)
    assert abs(model.joint("door_f_l") - 34.0) < 1e-3
    model.set_option("kit", "offroad")
    assert model.option("kit") == "offroad"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
