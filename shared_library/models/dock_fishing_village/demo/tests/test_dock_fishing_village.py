from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("dock_fishing_village: the prefab spawns and its model's controls work")
async def test_dock_fishing_village(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.dock_fishing_village, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("shed_door", 50.0)
    assert abs(model.joint("shed_door") - 50.0) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
