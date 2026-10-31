from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("roman_column_doric: the prefab spawns and its model's controls work")
async def test_roman_column_doric(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.roman_column_doric, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("stone", "travertine")
    assert model.option("stone") == "travertine"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
