from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("runway_windsock: the prefab spawns and its model's controls work")
async def test_runway_windsock(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.runway_windsock, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("mast", 44.0)
    assert abs(model.joint("mast") - 44.0) < 1e-3
    model.set_option("stripe_colour", "red")
    assert model.option("stripe_colour") == "red"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
