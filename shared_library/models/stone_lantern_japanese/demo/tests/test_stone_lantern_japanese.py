from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("stone_lantern_japanese: the prefab spawns and its model's controls work")
async def test_stone_lantern_japanese(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.stone_lantern_japanese, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("stone", "weathered")
    assert model.option("stone") == "weathered"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
