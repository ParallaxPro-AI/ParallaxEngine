from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("coin_pusher: the prefab spawns and its model's controls work")
async def test_coin_pusher(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.coin_pusher, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("chute_head", 0.0)
    assert abs(model.joint("chute_head") - 0.0) < 1e-3
    model.set_option("livery", "blue")
    assert model.option("livery") == "blue"
    assert model.socket_position("socket_topper").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
