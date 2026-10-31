from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("food_mixer_cart: the prefab spawns and its model's controls work")
async def test_food_mixer_cart(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.food_mixer_cart, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("mid_shelf", 0.15)
    assert abs(model.joint("mid_shelf") - 0.15) < 1e-3
    assert model.socket_position("socket_worktop").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
