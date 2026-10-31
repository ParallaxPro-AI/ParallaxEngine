from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("curtain: the prefab spawns and its model's controls work")
async def test_curtain(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.curtain, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("panel_l", 0.43)
    assert abs(model.joint("panel_l") - 0.43) < 1e-3
    model.set_option("state", "parted")
    assert model.option("state") == "parted"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
