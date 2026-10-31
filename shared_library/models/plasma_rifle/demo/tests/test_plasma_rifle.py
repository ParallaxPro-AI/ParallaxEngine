from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("plasma_rifle: the prefab spawns and its model's controls work")
async def test_plasma_rifle(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.plasma_rifle, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("trigger", 11.0)
    assert abs(model.joint("trigger") - 11.0) < 1e-3
    model.set_option("finish", "graphite")
    assert model.option("finish") == "graphite"
    assert model.socket_position("socket_muzzle").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
