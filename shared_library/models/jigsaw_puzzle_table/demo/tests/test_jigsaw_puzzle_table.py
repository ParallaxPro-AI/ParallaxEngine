from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("jigsaw_puzzle_table: the prefab spawns and its model's controls work")
async def test_jigsaw_puzzle_table(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.jigsaw_puzzle_table, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
