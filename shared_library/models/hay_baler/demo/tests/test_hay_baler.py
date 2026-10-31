from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("hay_baler: the prefab spawns and its model's controls work")
async def test_hay_baler(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.hay_baler, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("bale_chamber", 40.0)
    assert abs(model.joint("bale_chamber") - 40.0) < 1e-3
    assert model.socket_position("socket_hitch").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
