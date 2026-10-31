from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("tennis_court_net_post: the prefab spawns and its model's controls work")
async def test_tennis_court_net_post(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.tennis_court_net_post, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("post", "black")
    assert model.option("post") == "black"
    assert model.socket_position("socket_net_centre").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
