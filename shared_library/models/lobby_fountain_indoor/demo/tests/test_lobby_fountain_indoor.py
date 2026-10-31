from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("lobby_fountain_indoor: the prefab spawns and its model's controls work")
async def test_lobby_fountain_indoor(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.lobby_fountain_indoor, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("stone", "travertine")
    assert model.option("stone") == "travertine"
    assert model.socket_position("seat_coping_s").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
