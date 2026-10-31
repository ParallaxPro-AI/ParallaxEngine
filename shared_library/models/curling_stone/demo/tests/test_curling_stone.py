from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("curling_stone: the prefab spawns and its model's controls work")
async def test_curling_stone(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.curling_stone, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("team", "yellow")
    assert model.option("team") == "yellow"
    assert model.socket_position("grip").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
