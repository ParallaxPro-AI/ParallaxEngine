from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("cassette_player: the prefab spawns and its model's controls work")
async def test_cassette_player(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.cassette_player, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("deck_door", 20.0)
    assert abs(model.joint("deck_door") - 20.0) < 1e-3
    model.set_option("body_colour", "silver")
    assert model.option("body_colour") == "silver"
    assert model.socket_position("socket_handle").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
