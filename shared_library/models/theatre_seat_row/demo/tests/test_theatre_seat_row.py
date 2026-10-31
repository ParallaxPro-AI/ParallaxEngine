from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("theatre_seat_row: the prefab spawns and its model's controls work")
async def test_theatre_seat_row(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.theatre_seat_row, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tip_0", -41.0)
    assert abs(model.joint("tip_0") - -41.0) < 1e-3
    model.set_option("upholstery", "royal_blue")
    assert model.option("upholstery") == "royal_blue"
    assert model.socket_position("seat_0").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
