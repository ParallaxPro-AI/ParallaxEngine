from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("proto_cube_grid: the prefab spawns and its model's controls work")
async def test_proto_cube_grid(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.proto_cube_grid, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("finish", "orange")
    assert model.option("finish") == "orange"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
