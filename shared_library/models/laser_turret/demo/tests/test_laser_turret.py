from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("laser_turret: the prefab spawns and its model's controls work")
async def test_laser_turret(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.laser_turret, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("pitch", 21.5)
    assert abs(model.joint("pitch") - 21.5) < 1e-3
    model.set_option("glow_colour", "amber")
    assert model.option("glow_colour") == "amber"
    assert model.socket_position("socket_muzzle").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
