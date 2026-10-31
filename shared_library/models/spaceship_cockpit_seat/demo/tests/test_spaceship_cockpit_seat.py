from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("spaceship_cockpit_seat: the prefab spawns and its model's controls work")
async def test_spaceship_cockpit_seat(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.spaceship_cockpit_seat, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("seat", 0.0)
    assert abs(model.joint("seat") - 0.0) < 1e-3
    model.set_option("upholstery", "tan")
    assert model.option("upholstery") == "tan"
    assert model.socket_position("seat_pilot").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
