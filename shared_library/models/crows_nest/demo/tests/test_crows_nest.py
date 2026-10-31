from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("crows_nest: the prefab spawns and its model's controls work")
async def test_crows_nest(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.crows_nest, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("hatch", 52.5)
    assert abs(model.joint("hatch") - 52.5) < 1e-3
    model.set_option("flag", "none")
    assert model.option("flag") == "none"
    assert model.socket_position("lookout").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
