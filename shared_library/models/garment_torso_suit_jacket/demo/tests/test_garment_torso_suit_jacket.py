from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("garment_torso_suit_jacket: the prefab spawns and its model's controls work")
async def test_garment_torso_suit_jacket(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.garment_torso_suit_jacket, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("channel0", "navy")
    assert model.option("channel0") == "navy"
    assert model.socket_position("grip_r").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
