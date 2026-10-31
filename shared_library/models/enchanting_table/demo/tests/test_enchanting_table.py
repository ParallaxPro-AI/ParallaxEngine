from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("enchanting_table: the prefab spawns and its model's controls work")
async def test_enchanting_table(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.enchanting_table, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("hover", 0.025)
    assert abs(model.joint("hover") - 0.025) < 1e-3
    model.set_option("cloth", "blue")
    assert model.option("cloth") == "blue"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
