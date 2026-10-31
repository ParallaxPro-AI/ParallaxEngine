from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("gallows: the prefab spawns and its model's controls work")
async def test_gallows(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.gallows, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("trap_l", 46.0)
    assert abs(model.joint("trap_l") - 46.0) < 1e-3
    model.set_option("noose", "bare")
    assert model.option("noose") == "bare"
    assert model.socket_position("socket_trap").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
