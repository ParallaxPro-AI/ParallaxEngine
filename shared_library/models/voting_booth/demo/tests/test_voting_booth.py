from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("voting_booth: the prefab spawns and its model's controls work")
async def test_voting_booth(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.voting_booth, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("curtain_left", 0.62)
    assert abs(model.joint("curtain_left") - 0.62) < 1e-3
    model.set_option("panels", "grey")
    assert model.option("panels") == "grey"
    assert model.socket_position("socket_voter").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
