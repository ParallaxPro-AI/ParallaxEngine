from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("plasma_cannon: the prefab spawns and its model's controls work")
async def test_plasma_cannon(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.plasma_cannon, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("trigger", 10.0)
    assert abs(model.joint("trigger") - 10.0) < 1e-3
    model.set_option("armor_colour", "graphite")
    assert model.option("armor_colour") == "graphite"
    assert model.socket_position("socket_muzzle").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
