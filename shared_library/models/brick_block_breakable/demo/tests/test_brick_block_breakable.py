from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("brick_block_breakable: the prefab spawns and its model's controls work")
async def test_brick_block_breakable(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.brick_block_breakable, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("block", 0.06)
    assert abs(model.joint("block") - 0.06) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
