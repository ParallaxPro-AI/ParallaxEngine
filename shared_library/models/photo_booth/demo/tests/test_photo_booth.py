from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("photo_booth: the prefab spawns and its model's controls work")
async def test_photo_booth(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.photo_booth, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("curtain", 0.59)
    assert abs(model.joint("curtain") - 0.59) < 1e-3
    model.set_option("body", "blue")
    assert model.option("body") == "blue"
    assert model.socket_position("seat_sitter").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
