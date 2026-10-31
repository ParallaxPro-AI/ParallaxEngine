from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("amp_stack_full: the prefab spawns and its model's controls work")
async def test_amp_stack_full(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.amp_stack_full, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("knob_presence", 140.0)
    assert abs(model.joint("knob_presence") - 140.0) < 1e-3
    model.set_option("tolex", "cream")
    assert model.option("tolex") == "cream"
    assert model.socket_position("top").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
