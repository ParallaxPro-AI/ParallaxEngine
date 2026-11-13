"""Babble (library piece `babble`): speech-like gibberish voices for any line of text.

`speak(ctx, speaker, text)` turns the text into syllables and plays them one after another
from a bank of synthesized syllables (`assets/sfx/babble_*.synth.json`: a voiced buzz
through vowel formants after a plosive, nasal, fricative or liquid onset). The text decides
what you hear, so a line always sounds the same and two lines never do:

    - Latin, Cyrillic, Greek, Arabic, Indic... text: about one syllable per two letters, its
      consonants and vowels choosing the onset and vowel (Latin letters by sound class).
    - Chinese, Japanese and Korean: one syllable per character.
    - Punctuation is intonation: "?" rises at the end, "!" starts high and loud, "," and
      "." pause. A falling declination runs through every phrase.

Options shape the voice: `voice` "lo" or "hi", `pitch` (a multiplier on the voice),
`rate` (syllables faster or slower), `volume`, `mood` ("calm", "excited", "frustrated",
"sad", "pleading", "shout") and `tonal` (each syllable on its own pitch level, the sound of
a tone language).

`Babble` (list it in `Game(systems=[...])`) plays what is due each frame, at the speaker's
position, and emits `Babbled` per syllable (`openness` 0..1 for a mouth to flap) and
`BabbleFinished` after the last. `speak` returns the line's length in seconds; `stop`
cuts a speaker off. Pending syllables live in a scene resource, so they survive a save."""

from parallax import Entity, System, event, field, record, resource, system
from project import Assets

# Onset-major: index = onset * 5 + vowel, onsets "v" (none), "p", "n", "s", "l"; vowels a e i o u.
LO = [
    Assets.sfx.babble_lo_va, Assets.sfx.babble_lo_ve, Assets.sfx.babble_lo_vi, Assets.sfx.babble_lo_vo, Assets.sfx.babble_lo_vu,
    Assets.sfx.babble_lo_pa, Assets.sfx.babble_lo_pe, Assets.sfx.babble_lo_pi, Assets.sfx.babble_lo_po, Assets.sfx.babble_lo_pu,
    Assets.sfx.babble_lo_na, Assets.sfx.babble_lo_ne, Assets.sfx.babble_lo_ni, Assets.sfx.babble_lo_no, Assets.sfx.babble_lo_nu,
    Assets.sfx.babble_lo_sa, Assets.sfx.babble_lo_se, Assets.sfx.babble_lo_si, Assets.sfx.babble_lo_so, Assets.sfx.babble_lo_su,
    Assets.sfx.babble_lo_la, Assets.sfx.babble_lo_le, Assets.sfx.babble_lo_li, Assets.sfx.babble_lo_lo, Assets.sfx.babble_lo_lu,
]
HI = [
    Assets.sfx.babble_hi_va, Assets.sfx.babble_hi_ve, Assets.sfx.babble_hi_vi, Assets.sfx.babble_hi_vo, Assets.sfx.babble_hi_vu,
    Assets.sfx.babble_hi_pa, Assets.sfx.babble_hi_pe, Assets.sfx.babble_hi_pi, Assets.sfx.babble_hi_po, Assets.sfx.babble_hi_pu,
    Assets.sfx.babble_hi_na, Assets.sfx.babble_hi_ne, Assets.sfx.babble_hi_ni, Assets.sfx.babble_hi_no, Assets.sfx.babble_hi_nu,
    Assets.sfx.babble_hi_sa, Assets.sfx.babble_hi_se, Assets.sfx.babble_hi_si, Assets.sfx.babble_hi_so, Assets.sfx.babble_hi_su,
    Assets.sfx.babble_hi_la, Assets.sfx.babble_hi_le, Assets.sfx.babble_hi_li, Assets.sfx.babble_hi_lo, Assets.sfx.babble_hi_lu,
]

VOWELS = "aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüýœąęėīūůőűəıаеёиоуыэюяαεηιουωάέήίόύώ"
VOWEL_OF = "aeiouiaaaaaaaeeeeiiiioooooouuuuieaeeiuuoueiaeoiouieuaaeiioioaeiioio"
PLOSIVE = "pbtdkgcqćčďťķġğπβτδκγпбтдкгц"
NASAL = "mnñńňŋμνмн"
FRICATIVE = "fvszhxjçšžßśźżşșθφχσςψζξфвсзхшщжч"
LIQUID = "lrwłřλρлрй"
QUESTION = "?？¿;؟"
EXCLAIM = "!！¡"
PAUSE = ",，、;؛:—–…"
STOP = ".。।॥።"
OPENNESS = [1.0, 0.6, 0.4, 0.8, 0.45]
MOODS = {  # pitch, rate, volume, pitch range
    "calm": (1.0, 1.0, 1.0, 1.0),
    "excited": (1.12, 1.15, 1.1, 1.4),
    "frustrated": (1.08, 1.2, 1.25, 1.5),
    "sad": (0.9, 0.82, 0.8, 0.6),
    "pleading": (1.06, 0.95, 0.95, 1.2),
    "shout": (1.18, 1.05, 1.5, 1.6),
}


@record
class BabbleNote:
    """One syllable waiting to be heard."""
    speaker: Entity | None = field(None)
    at: float = field(0, unit="s", doc="Game time it plays.")
    sound: int = field(0, doc="Index into the voice's bank (onset * 5 + vowel).")
    high: bool = field(False, doc="The 'hi' bank.")
    pitch: float = field(1)
    volume: float = field(1)
    last: bool = field(False, doc="The line's final syllable.")


@resource("babble_queue", keep="scene")
class BabbleQueue:
    notes: list[BabbleNote] = field([])


@event("babbled", target="speaker")
class Babbled:
    """A syllable started: `openness` 0..1 is how wide its vowel opens a mouth."""
    speaker: Entity
    openness: float
    loud: bool


@event("babble_finished", target="speaker")
class BabbleFinished:
    speaker: Entity


def _hash(text: str) -> int:
    h = 2166136261
    for ch in text:
        h = ((h ^ ord(ch)) * 16777619) % 4294967296
    return h


def _dense(code: int) -> bool:
    """Scripts written a syllable per character: kana, CJK ideographs, hangul."""
    return (0x3040 <= code <= 0x30FF) or (0x3400 <= code <= 0x9FFF) or (0xAC00 <= code <= 0xD7AF) or (0xF900 <= code <= 0xFAFF)


def _onset(ch: str) -> int:
    if ch in PLOSIVE:
        return 1
    if ch in NASAL:
        return 2
    if ch in FRICATIVE:
        return 3
    if ch in LIQUID:
        return 4
    return -1


def syllables(text: str) -> list[list]:
    """The line as [onset, vowel, word_start, pause_after] syllables (pause: 0 none, 1 word,
    2 comma, 3 stop). Deterministic: a function of the text alone."""
    out = []
    seed = _hash(text)
    word_start = True
    pending = -1  # an onset waiting for its vowel
    letters = 0  # letters since the last syllable, for scripts without Latin vowels
    for ch in text.lower():
        code = ord(ch)
        if ch == " " or ch == "\n" or ch == "\t" or code == 0x3000:
            if word_start and pending >= 0:
                out.append([pending, 1, True, 0])  # a word of consonants: one murmured syllable
            if out:
                out[len(out) - 1][3] = max(out[len(out) - 1][3], 1)
            word_start = True
            pending = -1
            letters = 0
            continue
        if ch in PAUSE or ch in QUESTION or ch in EXCLAIM or ch in STOP or ch in "\"'«»“”„()[]-·":
            if out and (ch in PAUSE or ch in STOP):
                out[len(out) - 1][3] = 2 if ch in PAUSE else 3
            continue
        seed = (seed * 1103515245 + 12345 + code) % 2147483648
        if _dense(code):
            out.append([seed % 5, (seed // 7) % 5, word_start, 0])
            word_start = False
            continue
        vowel = VOWELS.find(ch)
        if vowel >= 0:
            if letters == 0 and out and not word_start and pending < 0:
                continue  # a diphthong: one syllable
            out.append([max(0, pending), "aeiou".find(VOWEL_OF[vowel]), word_start, 0])
            word_start = False
            pending = -1
            letters = 0
            continue
        onset = _onset(ch)
        if onset >= 0:
            pending = onset
            letters = 0
            continue
        if code < 0x250 or ch.isdigit():
            continue  # other Latin marks and digits
        # Any other script: a syllable per two letters, its sounds from the letters' codes.
        letters += 1
        if letters >= 2 or word_start:
            out.append([seed % 5, (code + seed // 11) % 5, word_start, 0])
            word_start = False
            letters = 0
    if word_start and pending >= 0:
        out.append([pending, 1, True, 0])
    if not out:
        out.append([0, 0, True, 0])
    return out


def speak(ctx, speaker: Entity, text: str, *, voice: str = "lo", pitch: float = 1.0, rate: float = 1.0,
          volume: float = 1.0, mood: str = "calm", tonal: bool = False, max_syllables: int = 28) -> float:
    """Queue `text` as babble from `speaker`. Returns its length in seconds."""
    stop(ctx, speaker)
    mood_pitch, mood_rate, mood_volume, spread = MOODS.get(mood, MOODS["calm"])
    parts = syllables(text)[:max_syllables]
    n = len(parts)
    question = False
    exclaim = False
    for ch in text:
        if ch in QUESTION:
            question = True
        if ch in EXCLAIM:
            exclaim = True
    step = 0.128 / max(0.2, rate * mood_rate)
    seed = _hash(text + voice)
    t = ctx.time.now + 0.05
    notes = ctx.get(BabbleQueue).notes
    for i in range(n):
        onset, vowel, first, pause = parts[i]
        u = i / max(1, n - 1)
        level = 1.06 - 0.14 * u * spread
        if first:
            level += 0.05 * spread
        if exclaim and i < 2:
            level += 0.12 * spread
        if question and i >= n - 2:
            level = 1.0 + (0.16 if i == n - 2 else 0.32) * max(1.0, spread * 0.8)
        if mood == "pleading" and pause >= 1:
            level += 0.1
        seed = (seed * 1103515245 + 12345) % 2147483648
        if tonal:
            level *= [0.86, 1.0, 1.12, 1.2, 0.94][seed % 5]
        level *= 1 + ((seed // 3) % 100 - 50) * 0.0008 * spread
        loud = first or (exclaim and i == 0)
        notes.append(BabbleNote(speaker=speaker, at=t, sound=onset * 5 + vowel, high=voice == "hi",
                                pitch=max(0.5, pitch * mood_pitch * level),
                                volume=max(0.05, volume * mood_volume * (1.0 if loud else 0.82)),
                                last=i == n - 1))
        t += step * (1.18 if first else 1.0) * (0.92 + (seed % 17) * 0.01)
        t += [0, 0.045, 0.2, 0.3][pause] / max(0.2, rate * mood_rate)
    return t - ctx.time.now


def stop(ctx, speaker: Entity) -> None:
    """Cut `speaker` off: its pending syllables are dropped."""
    queue = ctx.get(BabbleQueue)
    queue.notes = [note for note in queue.notes if note.speaker != speaker]


def speaking(ctx, speaker: Entity) -> bool:
    return any(note.speaker == speaker for note in ctx.get(BabbleQueue).notes)


@system("babble")
class Babble(System):
    """Plays queued syllables when they are due."""

    def update(self, ctx, dt):
        queue = ctx.get(BabbleQueue)
        if not queue.notes:
            return
        now = ctx.time.now
        due = [note for note in queue.notes if note.at <= now]
        if not due:
            return
        queue.notes = [note for note in queue.notes if note.at > now]
        for note in due:
            speaker = note.speaker
            if speaker is None or not speaker.alive:
                continue
            bank = HI if note.high else LO
            ctx.audio.play(bank[note.sound], at=speaker, volume=note.volume, pitch=note.pitch)
            ctx.emit(Babbled(speaker=speaker, openness=OPENNESS[note.sound % 5], loud=note.volume > 1.1))
            if note.last:
                ctx.emit(BabbleFinished(speaker=speaker))
