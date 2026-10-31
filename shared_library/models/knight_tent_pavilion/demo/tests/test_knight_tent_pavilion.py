from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("knight_tent_pavilion: the prefab spawns and its model's controls work")
async def test_knight_tent_pavilion(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.knight_tent_pavilion, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("flap_r", 75.0)
    assert abs(model.joint("flap_r") - 75.0) < 1e-3
    model.set_option("stripe", "blue")
    assert model.option("stripe") == "blue"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
