from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("chemical_drum: the prefab spawns and its model's controls work")
async def test_chemical_drum(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.chemical_drum, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("paint", "red")
    assert model.option("paint") == "red"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
