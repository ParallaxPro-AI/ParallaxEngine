from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("pitching_machine: the prefab spawns and its model's controls work")
async def test_pitching_machine(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.pitching_machine, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("head_pan", 0.0)
    assert abs(model.joint("head_pan") - 0.0) < 1e-3
    model.set_option("guard", "black")
    assert model.option("guard") == "black"
    assert model.socket_position("socket_release").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
