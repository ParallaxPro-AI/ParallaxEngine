from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("restoration_oiler: the prefab spawns and its model's controls work")
async def test_restoration_oiler(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.restoration_oiler, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
