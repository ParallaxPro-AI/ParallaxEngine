from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("house_stairs_spiral: the prefab spawns and its model's controls work")
async def test_house_stairs_spiral(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.house_stairs_spiral, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("wood", "walnut")
    assert model.option("wood") == "walnut"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
