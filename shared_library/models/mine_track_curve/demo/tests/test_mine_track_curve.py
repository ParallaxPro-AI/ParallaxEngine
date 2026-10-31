from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("mine_track_curve: the prefab spawns and its model's controls work")
async def test_mine_track_curve(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.mine_track_curve, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    assert model.socket_position("cart_entry").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
