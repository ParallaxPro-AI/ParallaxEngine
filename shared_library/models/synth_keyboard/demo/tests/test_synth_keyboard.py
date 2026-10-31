from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("synth_keyboard: the prefab spawns and its model's controls work")
async def test_synth_keyboard(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.synth_keyboard, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("keys", 2.0)
    assert abs(model.joint("keys") - 2.0) < 1e-3
    model.set_option("cheeks", "black")
    assert model.option("cheeks") == "black"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
