from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("whale_humpback: the prefab spawns and its model's controls work")
async def test_whale_humpback(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.whale_humpback, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("flipper_l", 0.0)
    assert abs(model.joint("flipper_l") - 0.0) < 1e-3
    model.set_option("skin", "grey")
    assert model.option("skin") == "grey"
    assert model.socket_position("back").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
