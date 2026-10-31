from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("wrap_station: the prefab spawns and its model's controls work")
async def test_wrap_station(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.wrap_station, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("carriage", 0.875)
    assert abs(model.joint("carriage") - 0.875) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
