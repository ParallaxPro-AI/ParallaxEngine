from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("drum_kit: the prefab spawns and its model's controls work")
async def test_drum_kit(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.drum_kit, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("hihat", 0.021)
    assert abs(model.joint("hihat") - 0.021) < 1e-3
    model.set_option("kit_size", "four_piece")
    assert model.option("kit_size") == "four_piece"
    assert model.socket_position("socket_throne").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
