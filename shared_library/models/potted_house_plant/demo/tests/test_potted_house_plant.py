from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("potted_house_plant: the prefab spawns and its model's controls work")
async def test_potted_house_plant(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.potted_house_plant, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("pot", "white")
    assert model.option("pot") == "white"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
