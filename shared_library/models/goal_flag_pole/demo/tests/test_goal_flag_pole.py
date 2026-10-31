from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("goal_flag_pole: the prefab spawns and its model's controls work")
async def test_goal_flag_pole(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.goal_flag_pole, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("flag", 1.8)
    assert abs(model.joint("flag") - 1.8) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
