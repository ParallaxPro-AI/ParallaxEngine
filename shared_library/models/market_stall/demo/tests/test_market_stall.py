from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("market_stall: the prefab spawns and its model's controls work")
async def test_market_stall(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.market_stall, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("awning", 36.0)
    assert abs(model.joint("awning") - 36.0) < 1e-3
    model.set_option("stripes", "green")
    assert model.option("stripes") == "green"
    assert model.socket_position("socket_vendor").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
