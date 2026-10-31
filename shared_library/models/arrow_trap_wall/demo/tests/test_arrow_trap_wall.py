from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("arrow_trap_wall: the prefab spawns and its model's controls work")
async def test_arrow_trap_wall(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.arrow_trap_wall, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("arrows", 0.275)
    assert abs(model.joint("arrows") - 0.275) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
