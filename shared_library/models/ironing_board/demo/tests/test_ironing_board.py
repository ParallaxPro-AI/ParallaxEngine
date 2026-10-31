from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("ironing_board: the prefab spawns and its model's controls work")
async def test_ironing_board(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.ironing_board, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("legs_a", 28.78)
    assert abs(model.joint("legs_a") - 28.78) < 1e-3
    model.set_option("iron", "none")
    assert model.option("iron") == "none"
    assert model.socket_position("socket_deck").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
