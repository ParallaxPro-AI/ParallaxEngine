from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("cabbage: the prefab spawns and its model's controls work")
async def test_cabbage(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.cabbage, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("variety", "savoy")
    assert model.option("variety") == "savoy"
    await game.advance(seconds=1)
