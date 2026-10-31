from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("checkpoint_flag: the prefab spawns and its model's controls work")
async def test_checkpoint_flag(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.checkpoint_flag, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("flag", 0.6)
    assert abs(model.joint("flag") - 0.6) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
