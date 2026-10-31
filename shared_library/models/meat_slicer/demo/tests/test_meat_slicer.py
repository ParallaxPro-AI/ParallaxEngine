from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("meat_slicer: the prefab spawns and its model's controls work")
async def test_meat_slicer(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.meat_slicer, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("thickness_knob", 150.0)
    assert abs(model.joint("thickness_knob") - 150.0) < 1e-3
    model.set_option("finish", "red")
    assert model.option("finish") == "red"
    assert model.socket_position("slice_out").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
