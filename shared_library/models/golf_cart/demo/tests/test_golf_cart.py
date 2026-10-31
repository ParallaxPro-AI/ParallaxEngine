from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("golf_cart: the prefab spawns and its model's controls work")
async def test_golf_cart(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.golf_cart, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("windscreen_fold", 84.0)
    assert abs(model.joint("windscreen_fold") - 84.0) < 1e-3
    model.set_option("paint", "cream")
    assert model.option("paint") == "cream"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
