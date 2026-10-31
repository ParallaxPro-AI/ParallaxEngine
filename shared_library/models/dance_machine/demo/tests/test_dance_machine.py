from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("dance_machine: the prefab spawns and its model's controls work")
async def test_dance_machine(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.dance_machine, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("pad_p1_up", 0.004)
    assert abs(model.joint("pad_p1_up") - 0.004) < 1e-3
    model.set_option("arrows", "green")
    assert model.option("arrows") == "green"
    assert model.socket_position("dancer_p1").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
