from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("metal_detector_gate: the prefab spawns and its model's controls work")
async def test_metal_detector_gate(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.metal_detector_gate, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("status", "alarm")
    assert model.option("status") == "alarm"
    assert model.socket_position("socket_pass").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
