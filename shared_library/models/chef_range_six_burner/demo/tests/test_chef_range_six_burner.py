from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("chef_range_six_burner: the prefab spawns and its model's controls work")
async def test_chef_range_six_burner(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.chef_range_six_burner, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("knob_1", 135.0)
    assert abs(model.joint("knob_1") - 135.0) < 1e-3
    model.set_option("finish", "black")
    assert model.option("finish") == "black"
    assert model.socket_position("burner_1").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
