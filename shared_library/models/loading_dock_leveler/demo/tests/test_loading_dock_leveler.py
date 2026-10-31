from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("loading_dock_leveler: the prefab spawns and its model's controls work")
async def test_loading_dock_leveler(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.loading_dock_leveler, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("deck", 5.0)
    assert abs(model.joint("deck") - 5.0) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
