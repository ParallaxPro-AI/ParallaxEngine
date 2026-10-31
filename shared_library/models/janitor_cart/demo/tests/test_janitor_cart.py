from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("janitor_cart: the prefab spawns and its model's controls work")
async def test_janitor_cart(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.janitor_cart, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("wringer_handle", 30.0)
    assert abs(model.joint("wringer_handle") - 30.0) < 1e-3
    model.set_option("body", "black")
    assert model.option("body") == "black"
    assert model.socket_position("socket_push").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
