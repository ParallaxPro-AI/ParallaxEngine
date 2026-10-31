from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("steel_girder: the prefab spawns and its model's controls work")
async def test_steel_girder(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.steel_girder, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("finish", "oxide")
    assert model.option("finish") == "oxide"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
