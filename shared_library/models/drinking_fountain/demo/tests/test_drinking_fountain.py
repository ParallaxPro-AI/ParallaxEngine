from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("drinking_fountain: the prefab spawns and its model's controls work")
async def test_drinking_fountain(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.drinking_fountain, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("button", 0.006)
    assert abs(model.joint("button") - 0.006) < 1e-3
    model.set_option("colour", "black")
    assert model.option("colour") == "black"
    assert model.socket_position("spout").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
