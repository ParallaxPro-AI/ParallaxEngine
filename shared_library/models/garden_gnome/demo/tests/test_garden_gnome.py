from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("garden_gnome: the prefab spawns and its model's controls work")
async def test_garden_gnome(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.garden_gnome, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("hat_colour", "red")
    assert model.option("hat_colour") == "red"
    assert model.socket_position("socket_hands").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
