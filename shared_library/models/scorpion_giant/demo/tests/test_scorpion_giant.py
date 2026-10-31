from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("scorpion_giant: the prefab spawns and its model's controls work")
async def test_scorpion_giant(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.scorpion_giant, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tail_strike", 12.5)
    assert abs(model.joint("tail_strike") - 12.5) < 1e-3
    model.set_option("shell", "sand")
    assert model.option("shell") == "sand"
    assert model.socket_position("stinger").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
