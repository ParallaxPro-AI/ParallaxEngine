from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("loading_canopy: the prefab spawns and its model's controls work")
async def test_loading_canopy(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.loading_canopy, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lip_l", 45.0)
    assert abs(model.joint("lip_l") - 45.0) < 1e-3
    model.set_option("frame", "blue")
    assert model.option("frame") == "blue"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
