from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("sentry_turret_floor: the prefab spawns and its model's controls work")
async def test_sentry_turret_floor(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.sentry_turret_floor, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("pitch", 10.0)
    assert abs(model.joint("pitch") - 10.0) < 1e-3
    assert model.socket_position("socket_muzzle").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
