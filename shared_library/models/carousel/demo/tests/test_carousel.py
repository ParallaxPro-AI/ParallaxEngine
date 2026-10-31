from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("carousel: the prefab spawns and its model's controls work")
async def test_carousel(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.carousel, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("bob_0", 0.2)
    assert abs(model.joint("bob_0") - 0.2) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
