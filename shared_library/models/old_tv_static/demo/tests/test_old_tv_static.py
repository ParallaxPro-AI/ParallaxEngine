from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("old_tv_static: the prefab spawns and its model's controls work")
async def test_old_tv_static(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.old_tv_static, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("channel", 165.0)
    assert abs(model.joint("channel") - 165.0) < 1e-3
    model.set_option("screen", "off")
    assert model.option("screen") == "off"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
