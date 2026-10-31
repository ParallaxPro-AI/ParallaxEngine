from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("apple: the prefab spawns and its model's controls work")
async def test_apple(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.apple, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("variety", "red")
    assert model.option("variety") == "red"
    await game.advance(seconds=1)
