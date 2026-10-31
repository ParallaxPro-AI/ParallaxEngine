from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("shop_counter: the prefab spawns and its model's controls work")
async def test_shop_counter(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.shop_counter, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("till_drawer", 0.21)
    assert abs(model.joint("till_drawer") - 0.21) < 1e-3
    assert model.socket_position("socket_worktop").distance_to(thing.transform.position) < 3.48
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
