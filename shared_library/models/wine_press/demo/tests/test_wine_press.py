from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("wine_press: the prefab spawns and its model's controls work")
async def test_wine_press(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.wine_press, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("platen", 0.06)
    assert abs(model.joint("platen") - 0.06) < 1e-3
    model.set_option("fruit", "white")
    assert model.option("fruit") == "white"
    assert model.socket_position("spout").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
