from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("sphinx_statue_small: the prefab spawns and its model's controls work")
async def test_sphinx_statue_small(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.sphinx_statue_small, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("stone", "granite")
    assert model.option("stone") == "granite"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
