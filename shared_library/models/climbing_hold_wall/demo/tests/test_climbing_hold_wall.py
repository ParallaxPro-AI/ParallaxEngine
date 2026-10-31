from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("climbing_hold_wall: the prefab spawns and its model's controls work")
async def test_climbing_hold_wall(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.climbing_hold_wall, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("wall", "charcoal")
    assert model.option("wall") == "charcoal"
    assert model.socket_position("socket_start_red").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
