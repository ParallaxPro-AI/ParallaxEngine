from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("hot_dog_cart: the prefab spawns and its model's controls work")
async def test_hot_dog_cart(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.hot_dog_cart, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lid_franks", 52.5)
    assert abs(model.joint("lid_franks") - 52.5) < 1e-3
    model.set_option("panel", "blue")
    assert model.option("panel") == "blue"
    assert model.socket_position("socket_vendor").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
