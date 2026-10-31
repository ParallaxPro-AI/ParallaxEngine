from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("jersey_barrier: the prefab spawns and its model's controls work")
async def test_jersey_barrier(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.jersey_barrier, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("finish", "weathered")
    assert model.option("finish") == "weathered"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
