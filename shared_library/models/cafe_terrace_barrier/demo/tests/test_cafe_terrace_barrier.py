from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("cafe_terrace_barrier: the prefab spawns and its model's controls work")
async def test_cafe_terrace_barrier(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.cafe_terrace_barrier, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("style", "banner")
    assert model.option("style") == "banner"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
