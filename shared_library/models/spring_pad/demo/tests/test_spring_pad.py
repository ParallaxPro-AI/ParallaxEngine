from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("spring_pad: the prefab spawns and its model's controls work")
async def test_spring_pad(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.spring_pad, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("plate", 0.04)
    assert abs(model.joint("plate") - 0.04) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
