from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("chips_bag: the prefab spawns and its model's controls work")
async def test_chips_bag(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.chips_bag, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("mouth_front", 37.0)
    assert abs(model.joint("mouth_front") - 37.0) < 1e-3
    model.set_option("flavour", "paprika")
    assert model.option("flavour") == "paprika"
    assert model.socket_position("socket_mouth").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
