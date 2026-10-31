from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("tree_pit_grate: the prefab spawns and its model's controls work")
async def test_tree_pit_grate(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.tree_pit_grate, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("finish", "bronze")
    assert model.option("finish") == "bronze"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
