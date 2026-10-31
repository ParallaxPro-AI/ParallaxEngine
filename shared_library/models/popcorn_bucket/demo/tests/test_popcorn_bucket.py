from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("popcorn_bucket: the prefab spawns and its model's controls work")
async def test_popcorn_bucket(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.popcorn_bucket, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("fill", "empty")
    assert model.option("fill") == "empty"
    await game.advance(seconds=1)
