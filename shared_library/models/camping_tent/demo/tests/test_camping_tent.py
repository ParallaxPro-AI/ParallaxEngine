from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("camping_tent: the prefab spawns and its model's controls work")
async def test_camping_tent(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.camping_tent, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door", 30.0)
    assert abs(model.joint("door") - 30.0) < 1e-3
    model.set_option("fly_colour", "green")
    assert model.option("fly_colour") == "green"
    assert model.socket_position("socket_door").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
