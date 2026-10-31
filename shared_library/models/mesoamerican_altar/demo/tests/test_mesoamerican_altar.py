from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("mesoamerican_altar: the prefab spawns and its model's controls work")
async def test_mesoamerican_altar(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.mesoamerican_altar, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("stone", "limestone")
    assert model.option("stone") == "limestone"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
