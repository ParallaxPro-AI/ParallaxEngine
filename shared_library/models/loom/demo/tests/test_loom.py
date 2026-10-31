from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("loom: the prefab spawns and its model's controls work")
async def test_loom(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.loom, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("shaft_1", 0.0225)
    assert abs(model.joint("shaft_1") - 0.0225) < 1e-3
    model.set_option("cloth", "blue")
    assert model.option("cloth") == "blue"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
