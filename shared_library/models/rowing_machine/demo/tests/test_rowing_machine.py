from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("rowing_machine: the prefab spawns and its model's controls work")
async def test_rowing_machine(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.rowing_machine, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("damper", 40.0)
    assert abs(model.joint("damper") - 40.0) < 1e-3
    model.set_option("accent", "blue")
    assert model.option("accent") == "blue"
    assert model.socket_position("socket_seat").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
