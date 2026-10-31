from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("riot_barrier_police: the prefab spawns and its model's controls work")
async def test_riot_barrier_police(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.riot_barrier_police, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("finish", "blue")
    assert model.option("finish") == "blue"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
