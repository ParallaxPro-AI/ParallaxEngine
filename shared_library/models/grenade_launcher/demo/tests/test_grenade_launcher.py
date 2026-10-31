from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("grenade_launcher: the prefab spawns and its model's controls work")
async def test_grenade_launcher(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.grenade_launcher, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cylinder_swing", 36.0)
    assert abs(model.joint("cylinder_swing") - 36.0) < 1e-3
    assert model.socket_position("socket_muzzle").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
