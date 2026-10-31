from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("food_cart_tricycle: the prefab spawns and its model's controls work")
async def test_food_cart_tricycle(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.food_cart_tricycle, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("box_steer", 0.0)
    assert abs(model.joint("box_steer") - 0.0) < 1e-3
    model.set_option("cart_colour", "red")
    assert model.option("cart_colour") == "red"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
