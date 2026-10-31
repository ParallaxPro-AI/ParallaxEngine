from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bathtub: the prefab spawns and its model's controls work")
async def test_bathtub(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bathtub, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tap", 17.5)
    assert abs(model.joint("tap") - 17.5) < 1e-3
    model.set_option("style", "built_in")
    assert model.option("style") == "built_in"
    assert model.socket_position("socket_well").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
