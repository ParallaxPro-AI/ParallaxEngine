from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("mine_cart: the prefab spawns and its model's controls work")
async def test_mine_cart(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.mine_cart, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tub", 24.0)
    assert abs(model.joint("tub") - 24.0) < 1e-3
    model.set_option("load", "full")
    assert model.option("load") == "full"
    assert model.socket_position("coupler_front").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
