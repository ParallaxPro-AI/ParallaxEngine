from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("rain_collector: the prefab spawns and its model's controls work")
async def test_rain_collector(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.rain_collector, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tap", 45.0)
    assert abs(model.joint("tap") - 45.0) < 1e-3
    assert model.socket_position("socket_spigot").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
