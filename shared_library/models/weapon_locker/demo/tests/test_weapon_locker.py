from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("weapon_locker: the prefab spawns and its model's controls work")
async def test_weapon_locker(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.weapon_locker, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_l", 55.0)
    assert abs(model.joint("door_l") - 55.0) < 1e-3
    model.set_option("finish", "olive")
    assert model.option("finish") == "olive"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
