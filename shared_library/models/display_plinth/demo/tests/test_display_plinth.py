from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("display_plinth: the prefab spawns and its model's controls work")
async def test_display_plinth(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.display_plinth, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("hood", 0.15)
    assert abs(model.joint("hood") - 0.15) < 1e-3
    model.set_option("style", "open")
    assert model.option("style") == "open"
    assert model.socket_position("display").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
