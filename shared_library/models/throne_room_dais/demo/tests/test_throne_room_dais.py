from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("throne_room_dais: the prefab spawns and its model's controls work")
async def test_throne_room_dais(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.throne_room_dais, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("carpet", "blue")
    assert model.option("carpet") == "blue"
    assert model.socket_position("throne").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
