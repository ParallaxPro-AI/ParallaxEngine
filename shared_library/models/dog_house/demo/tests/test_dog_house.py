from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("dog_house: the prefab spawns and its model's controls work")
async def test_dog_house(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.dog_house, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("roof", "green")
    assert model.option("roof") == "green"
    assert model.socket_position("socket_bed").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
