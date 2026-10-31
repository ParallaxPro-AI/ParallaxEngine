from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("mosaic_floor_tile: the prefab spawns and its model's controls work")
async def test_mosaic_floor_tile(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.mosaic_floor_tile, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("palette", "blue")
    assert model.option("palette") == "blue"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
