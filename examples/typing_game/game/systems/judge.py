from parallax import Context, Entity, System, system
from project import Placed, Scenes

from game.components import Word
from game.config import Rules
from game.events import ComboReached, KeyHit, KeyMissed, WordCleared, WordLocked
from game.resources import Run
from game.rules import lives_left

LETTERS = "abcdefghijklmnopqrstuvwxyz"


@system("judge", scenes=[Scenes.grid], when=lambda ctx: lives_left(ctx) > 0)
class Judge(System):
    """Judges every letter typed this frame on a keyboard. On a touch screen it doesn't
    read text, so the platform keyboard stays hidden and the HUD's own keyboard types
    instead (`type_key`, the HUD's `press` action). With no target, a letter locks onto
    the word nearest the firewall that starts with it. After that, the right next
    letter advances the word and a wrong one costs accuracy (not the word). A
    finished word is purged and scored: base plus length, times the combo, times the
    kind, plus a bonus for every meter it still had to fall."""

    def update(self, ctx, dt):
        if ctx.input.device == "touch":
            return
        for letter in ctx.input.text.lower():
            if letter in LETTERS:
                judge(ctx, letter)


def type_key(ctx: Context, key: str) -> None:
    """A key of the HUD's on-screen keyboard (touch), judged like a typed letter."""
    if key in LETTERS and lives_left(ctx) > 0:
        judge(ctx, key)


def judge(ctx: Context, letter: str) -> None:
    run = ctx.get(Run)
    target = run.target if run.target is not None and run.target.alive else lock_on(ctx, letter)
    if target is None:
        return
    run.target = target
    word = target.get(Word)
    run.keys_total += 1
    if word.text[word.typed] != letter:
        ctx.emit(KeyMissed(at=target.transform.position))
        return
    run.keys_correct += 1
    word.typed += 1
    ctx.emit(KeyHit(at=target.transform.position))
    if word.typed == len(word.text):
        purge(ctx, target)


def lock_on(ctx: Context, letter: str) -> Entity | None:
    """The untouched word starting with `letter` that is closest to the firewall."""
    candidates = ctx.world.query(Word).where(
        lambda entity, word: word.typed == 0 and word.text.startswith(letter)).to_list()
    if not candidates:
        return None
    entity, _ = max(candidates, key=lambda row: row[0].transform.position.z)
    ctx.emit(WordLocked(at=entity.transform.position))
    return entity


def purge(ctx: Context, target: Entity) -> None:
    rules = ctx.config(Rules)
    run = ctx.get(Run)
    word = target.get(Word)
    run.combo += 1
    run.max_combo = max(run.max_combo, run.combo)
    run.cleared += 1
    run.target = None

    base = rules.points_per_word + rules.points_per_letter * len(word.text)
    multiplier = 1 + rules.combo_step * min(run.combo, rules.combo_cap)
    still_to_fall = ctx.world.placed(Placed.firewall).transform.position.z - target.transform.position.z
    points = round(base * multiplier * word.kind.data.score_mult + rules.points_per_meter_left * still_to_fall)
    run.score += points

    ctx.emit(WordCleared(at=target.transform.position, kind=word.kind, points=points))
    if run.combo % rules.combo_milestone == 0:
        ctx.emit(ComboReached(combo=run.combo))
    target.destroy()
