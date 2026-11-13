from parallax.test import playtest
from project import Placed, Scenes

from game.lib.babble import BabbleFinished, BabbleQueue, Babbled, speak, speaking, stop, syllables


@playtest("a line plays one syllable per beat from its speaker, then finishes")
async def test_line(game):
    await game.start(scene=Scenes.stage)
    speaker = game.world.placed(Placed.speaker_a)
    text = "Hello there, how are you today?"
    seconds = speak(game.ctx, speaker, text, voice="hi")
    count = len(syllables(text))
    assert 8 <= count <= 12, count
    assert 0.8 < seconds < 3.5, seconds
    assert speaking(game.ctx, speaker)
    done = await game.until(BabbleFinished, timeout=5)
    assert done.speaker == speaker
    flaps = game.emitted(Babbled)
    assert len(flaps) == count
    assert all(f.speaker == speaker and 0 < f.openness <= 1 for f in flaps)
    assert not speaking(game.ctx, speaker)


@playtest("the text decides the syllables: dense scripts per character, others per sound")
async def test_syllables(game):
    await game.start(scene=Scenes.stage)
    assert syllables("今日はいい天気ですね") == syllables("今日はいい天気ですね")
    assert len(syllables("今日はいい天気ですね")) == 10
    assert len(syllables("날씨가 좋네요!")) == 6
    assert syllables("Добрый день!") != syllables("Добрый вечер!")
    assert 2 <= len(syllables("مرحبا بك")) <= 6
    words = syllables("ab cd ef")
    assert [s[2] for s in words] == [True, True, True]


@playtest("a question rises at the end; stop() silences a speaker")
async def test_question_and_stop(game):
    await game.start(scene=Scenes.stage)
    speaker = game.world.placed(Placed.speaker_b)
    speak(game.ctx, speaker, "Quieres venir conmigo?")
    notes = game.ctx.get(BabbleQueue).notes
    assert notes[len(notes) - 1].pitch > notes[0].pitch
    speak(game.ctx, speaker, "Basta ya!", mood="shout")
    loud = game.ctx.get(BabbleQueue).notes
    assert len(loud) == len(syllables("Basta ya!"))
    assert loud[0].volume > 1.2
    stop(game.ctx, speaker)
    await game.advance(seconds=1)
    assert game.emitted(Babbled) == []
