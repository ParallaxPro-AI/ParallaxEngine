from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("dungeon_torture_rack: the prefab spawns and its model's controls work")
async def test_dungeon_torture_rack(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.dungeon_torture_rack, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("roller_r", 135.0)
    assert abs(model.joint("roller_r") - 135.0) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
