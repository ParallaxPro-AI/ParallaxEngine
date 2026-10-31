from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("persian_rug_rolled: the prefab spawns and its model's controls work")
async def test_persian_rug_rolled(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.persian_rug_rolled, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("field", "indigo")
    assert model.option("field") == "indigo"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
