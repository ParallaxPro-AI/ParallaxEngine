from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("medieval_market_cart: the prefab spawns and its model's controls work")
async def test_medieval_market_cart(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.medieval_market_cart, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tailgate", 47.5)
    assert abs(model.joint("tailgate") - 47.5) < 1e-3
    model.set_option("awning", "red")
    assert model.option("awning") == "red"
    assert model.socket_position("push").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
