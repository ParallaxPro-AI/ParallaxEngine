from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("radio: the prefab spawns and its model's controls work")
async def test_radio(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.radio, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tuning_dial", 150.0)
    assert abs(model.joint("tuning_dial") - 150.0) < 1e-3
    model.set_option("style", "boombox")
    assert model.option("style") == "boombox"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
