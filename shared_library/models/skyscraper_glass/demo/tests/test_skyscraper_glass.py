from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("skyscraper_glass: the prefab spawns and its model's controls work")
async def test_skyscraper_glass(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.skyscraper_glass, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("revolving_door", 45.0)
    assert abs(model.joint("revolving_door") - 45.0) < 1e-3
    model.set_option("glass_tint", "green")
    assert model.option("glass_tint") == "green"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
