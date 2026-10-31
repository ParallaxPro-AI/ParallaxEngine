from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("waiting_room_chairs: the prefab spawns and its model's controls work")
async def test_waiting_room_chairs(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.waiting_room_chairs, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("upholstery", "teal")
    assert model.option("upholstery") == "teal"
    assert model.socket_position("seat_0").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
