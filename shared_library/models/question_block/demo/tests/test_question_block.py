from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("question_block: the prefab spawns and its model's controls work")
async def test_question_block(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.question_block, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("block", 0.075)
    assert abs(model.joint("block") - 0.075) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
