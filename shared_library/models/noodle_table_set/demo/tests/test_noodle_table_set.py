from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("noodle_table_set: the prefab spawns and its model's controls work")
async def test_noodle_table_set(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.noodle_table_set, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
