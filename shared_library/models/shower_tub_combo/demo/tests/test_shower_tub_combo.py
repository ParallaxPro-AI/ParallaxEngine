from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("shower_tub_combo: the prefab spawns and its model's controls work")
async def test_shower_tub_combo(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.shower_tub_combo, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("curtain", 0.59)
    assert abs(model.joint("curtain") - 0.59) < 1e-3
    model.set_option("curtain_colour", "grey")
    assert model.option("curtain_colour") == "grey"
    assert model.socket_position("seat_bath").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
