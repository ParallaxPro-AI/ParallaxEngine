from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("fortune_booth: the prefab spawns and its model's controls work")
async def test_fortune_booth(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.fortune_booth, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("head_turn", 0.0)
    assert abs(model.joint("head_turn") - 0.0) < 1e-3
    model.set_option("velvet", "red")
    assert model.option("velvet") == "red"
    assert model.socket_position("socket_player").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
