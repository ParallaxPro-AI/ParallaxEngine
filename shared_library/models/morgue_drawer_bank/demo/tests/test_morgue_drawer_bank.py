from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("morgue_drawer_bank: the prefab spawns and its model's controls work")
async def test_morgue_drawer_bank(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.morgue_drawer_bank, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("drawer_0_0", 0.85)
    assert abs(model.joint("drawer_0_0") - 0.85) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
