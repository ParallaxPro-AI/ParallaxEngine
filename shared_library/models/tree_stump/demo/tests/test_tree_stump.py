from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("tree_stump: the prefab spawns and its model's controls work")
async def test_tree_stump(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.tree_stump, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
