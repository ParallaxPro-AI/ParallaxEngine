from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("siege_ram: the prefab spawns and its model's controls work")
async def test_siege_ram(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.siege_ram, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("ram", 0.0)
    assert abs(model.joint("ram") - 0.0) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
