from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("radio_mast: the prefab spawns and its model's controls work")
async def test_radio_mast(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.radio_mast, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("bands", "galvanised")
    assert model.option("bands") == "galvanised"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
