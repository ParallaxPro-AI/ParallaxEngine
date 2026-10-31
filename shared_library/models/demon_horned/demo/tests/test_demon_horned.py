from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("demon_horned: the prefab spawns and its model's controls work")
async def test_demon_horned(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.demon_horned, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("skin", "ash")
    assert model.option("skin") == "ash"
    assert model.socket_position("eye_point").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
