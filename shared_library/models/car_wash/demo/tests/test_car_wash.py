from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("car_wash: the prefab spawns and its model's controls work")
async def test_car_wash(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.car_wash, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("accent_colour", "green")
    assert model.option("accent_colour") == "green"
    assert model.socket_position("socket_wash_position").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
