from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("japanese_minka: the prefab spawns and its model's controls work")
async def test_japanese_minka(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.japanese_minka, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("shoji_1a", 0.39)
    assert abs(model.joint("shoji_1a") - 0.39) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
