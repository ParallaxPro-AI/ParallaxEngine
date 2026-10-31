from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("portrait_haunted: the prefab spawns and its model's controls work")
async def test_portrait_haunted(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.portrait_haunted, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("hang", 0.0)
    assert abs(model.joint("hang") - 0.0) < 1e-3
    model.set_option("eyes", "glowing")
    assert model.option("eyes") == "glowing"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
