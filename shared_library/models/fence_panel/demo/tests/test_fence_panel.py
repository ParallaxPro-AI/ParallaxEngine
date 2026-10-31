from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("fence_panel: the prefab spawns and its model's controls work")
async def test_fence_panel(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.fence_panel, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("gate", 50.0)
    assert abs(model.joint("gate") - 50.0) < 1e-3
    model.set_option("style", "chain_link")
    assert model.option("style") == "chain_link"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
