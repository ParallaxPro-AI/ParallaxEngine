from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("noodle_stall: the prefab spawns and its model's controls work")
async def test_noodle_stall(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.noodle_stall, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("pot_1_lid", 35.0)
    assert abs(model.joint("pot_1_lid") - 35.0) < 1e-3
    model.set_option("paint", "teal")
    assert model.option("paint") == "teal"
    assert model.socket_position("seat_1").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
