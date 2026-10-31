from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("crumbling_platform: the prefab spawns and its model's controls work")
async def test_crumbling_platform(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.crumbling_platform, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("state", "crumbled")
    assert model.option("state") == "crumbled"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
