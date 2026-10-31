from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("laser_grid: the prefab spawns and its model's controls work")
async def test_laser_grid(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.laser_grid, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("beams", 0.51)
    assert abs(model.joint("beams") - 0.51) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
