from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("tripod: the prefab spawns and its model's controls work")
async def test_tripod(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.tripod, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("fold_0", 9.5)
    assert abs(model.joint("fold_0") - 9.5) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
