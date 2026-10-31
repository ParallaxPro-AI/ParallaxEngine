from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("hot_air_balloon: the prefab spawns and its model's controls work")
async def test_hot_air_balloon(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.hot_air_balloon, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("basket", 4.5)
    assert abs(model.joint("basket") - 4.5) < 1e-3
    model.set_option("pattern", "sky")
    assert model.option("pattern") == "sky"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
