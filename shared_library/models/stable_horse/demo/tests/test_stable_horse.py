from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("stable_horse: the prefab spawns and its model's controls work")
async def test_stable_horse(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.stable_horse, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("stall1_lower", 85.0)
    assert abs(model.joint("stall1_lower") - 85.0) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
