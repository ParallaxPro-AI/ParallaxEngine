from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("temple_doorway: the prefab spawns and its model's controls work")
async def test_temple_doorway(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.temple_doorway, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("stone_door", 0.86)
    assert abs(model.joint("stone_door") - 0.86) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
