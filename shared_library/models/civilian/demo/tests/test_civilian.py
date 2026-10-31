from parallax import Model, vec3
from parallax.characters import Character
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("civilian: the prefab spawns and its model's controls work")
async def test_civilian(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.civilian, at=vec3(0, 1.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("skin", "pale")
    assert model.option("skin") == "pale"
    assert model.socket_position("eye_point").distance_to(thing.transform.position) < 3.85
    await game.advance(seconds=2)
    assert thing.get(Character).grounded
