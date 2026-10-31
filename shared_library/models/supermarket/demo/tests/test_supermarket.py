from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("supermarket: the prefab spawns and its model's controls work")
async def test_supermarket(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.supermarket, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lane_register_drawer_0", 0.15)
    assert abs(model.joint("lane_register_drawer_0") - 0.15) < 1e-3
    model.set_option("cladding_colour", "pale_grey_panel")
    assert model.option("cladding_colour") == "pale_grey_panel"
    assert model.socket_position("eye_point").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
