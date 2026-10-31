from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("watchtower_military: the prefab spawns and its model's controls work")
async def test_watchtower_military(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.watchtower_military, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("ladder_gate", 47.5)
    assert abs(model.joint("ladder_gate") - 47.5) < 1e-3
    model.set_option("paint", "sand")
    assert model.option("paint") == "sand"
    assert model.socket_position("ladder_bottom").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
