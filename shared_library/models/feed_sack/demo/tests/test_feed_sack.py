from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("feed_sack: the prefab spawns and its model's controls work")
async def test_feed_sack(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.feed_sack, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("sack_cloth", "white_poly")
    assert model.option("sack_cloth") == "white_poly"
    assert model.socket_position("socket_grip").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
