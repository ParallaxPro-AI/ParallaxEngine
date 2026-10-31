from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("arch: the prefab spawns and its model's controls work")
async def test_arch(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.arch, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("width", "double")
    assert model.option("width") == "double"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
