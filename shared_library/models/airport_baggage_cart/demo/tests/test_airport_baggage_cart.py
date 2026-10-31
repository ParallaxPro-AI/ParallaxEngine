from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("airport_baggage_cart: the prefab spawns and its model's controls work")
async def test_airport_baggage_cart(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.airport_baggage_cart, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("steer", 0.0)
    assert abs(model.joint("steer") - 0.0) < 1e-3
    model.set_option("curtains", "closed")
    assert model.option("curtains") == "closed"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
