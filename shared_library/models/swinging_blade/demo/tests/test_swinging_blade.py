from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("swinging_blade: the prefab spawns and its model's controls work")
async def test_swinging_blade(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.swinging_blade, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("pendulum", 0.0)
    assert abs(model.joint("pendulum") - 0.0) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
