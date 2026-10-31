from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("building_blocks: the prefab spawns and its model's controls work")
async def test_building_blocks(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.building_blocks, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("finish", "natural")
    assert model.option("finish") == "natural"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
