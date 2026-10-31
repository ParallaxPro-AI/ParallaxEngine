from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("buoy_navigation: the prefab spawns and its model's controls work")
async def test_buoy_navigation(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.buoy_navigation, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("mark", "green")
    assert model.option("mark") == "green"
    assert model.socket_position("mooring").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
