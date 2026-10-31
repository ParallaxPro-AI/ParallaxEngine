"""Story plugin (`plugins.story()`, `ctx.story`): facts, quests and dialogue.

Facts: persisted story state, declared as handles. Keys are snake_case identifiers
(no dots) so .yarn uses the same names: `fact("met_queen", False)` ↔ `$met_queen`.
Dialogue: .yarn files in story/ (codegen: `project.Dialogue.innkeeper`), calling game
code only through `@dialogue_command` functions. A voiced line names its sound with a
`#voice:<name>` tag (a sound in assets/sfx/): it plays as the line is shown, and the music
ducks under it (`AudioListener.duck_level`): `Elder: Welcome. #line:w1 #voice:elder_welcome`.
Quests: content entries of the built-in `quest` kind (content/quest/*.json) — step
graphs whose steps use a verb: reach, talk, obtain, defeat, use, wait, fact, or a
custom verb declared with `@quest_verb`.
World layers can follow story state declaratively in world.json:
  "layers": {"burned_village": {"active_when": {"quest_completed": "raid"}},
             "festival":       {"active_when": {"fact": "festival_started"}}}
Facts, quests and layers are run-level: `new_run=True` (New Game) resets them.
"""

from typing import Any, Callable, Generic, Literal, TypeVar
from parallax import ContentList, ContentRef, Context, Entity, Localized, Panel, content, event, field, record

F = TypeVar("F", bool, int, float, str)

class Fact(Generic[F]):
    key: str
    default: F

def fact(key: str, default: F) -> Fact[F]:
    """Declare a story fact: `MetQueen = fact("met_queen", False)`."""

class Facts:
    def get(self, f: Fact[F]) -> F: ...
    def set(self, f: Fact[F], value: F) -> None: ...
    def add(self, f: Fact[int] | Fact[float], amount: float = 1) -> float: ...


@record
class QuestBranch:
    """Take `goto` instead of `next` when the condition holds: a fact value, or the
    outcome string a custom verb returned for this step."""
    fact: str | None = field(None)
    outcome: str | None = field(None)
    equals: bool | int | str = field(True)
    goto: list[str] = field([])

@record
class QuestStep:
    text: Localized
    """Objective text shown in the tracker ("Ask the innkeeper about her brother")."""
    verb: str
    """reach | talk | obtain | defeat | use | wait | fact | a custom verb id."""
    target: str = field("")
    """Checked against what the verb declares (placed id, prefab id, content id, fact key).
    In verb code use `step.resolve(ctx)` to get it typed."""
    count: int = field(1)
    args: dict[str, Any] = field({})
    """Extra arguments for custom verbs, checked against the verb's declared args."""
    next: list[str] = field([])
    next_if: list[QuestBranch] = field([])
    """Branches: the first whose condition holds is taken instead of `next`."""
    sets: list[str] = field([])
    """Facts set to True when the step completes."""
    marker: str | None = field(None)
    """Placed-entity id to point the objective marker at."""
    def resolve(self, ctx: Context) -> Any:
        """The target as the verb's declared type (an EntityRef, PrefabRef, ContentRef…)."""

@content("quest")
class QuestDef:
    """Built-in content kind. Extend it to add game fields (rewards, chapter number):
    `@content("quest", order="chapter") class Chapter(QuestDef): ...`."""
    title: Localized
    summary: Localized
    start: str
    steps: dict[str, QuestStep]

class QuestState:
    status: Literal["inactive", "active", "completed", "failed"]
    active_steps: list[str]
    completed_steps: list[str]
    def progress(self, step: str) -> tuple[int, int]: ...

class DialogueRef:
    id: str

@event("dialogue_started")
class DialogueStarted:
    dialogue: DialogueRef
    speaker: Entity | None

@event("dialogue_ended")
class DialogueEnded:
    dialogue: DialogueRef

@event("quest_started")
class QuestStarted:
    quest: ContentRef[QuestDef]

@event("quest_step_completed")
class QuestStepCompleted:
    quest: ContentRef[QuestDef]
    """Use `event.quest.as_kind(Chapter)` for your subclass's fields."""
    step: str
    verb: str
    outcome: str | None

@event("quest_completed")
class QuestCompleted:
    quest: ContentRef[QuestDef]

@event("fact_changed")
class FactChanged:
    key: str

class StoryApi:
    facts: Facts
    def say(self, dialogue: DialogueRef, *, node: str = "start", speaker: Entity | None = None) -> None:
        """Start a conversation in the built-in DialoguePanel (modal) until it ends."""
    def quests(self, status: Literal["active", "completed", "all"] = "active") -> list[ContentRef[QuestDef]]: ...
    def start_quest(self, quest: ContentRef[QuestDef]) -> None: ...
    def fail_quest(self, quest: ContentRef[QuestDef]) -> None: ...
    def quest(self, quest: ContentRef[QuestDef]) -> QuestState: ...
    def report(self, verb: str, target: str, count: int = 1) -> None:
        """Report progress the plugin can't observe itself. Observed automatically:
        talk (say), defeat (combat Died, by prefab id), reach (trigger/region ids),
        obtain (when the game reports it), fact (FactChanged)."""
    @property
    def in_dialogue(self) -> bool: ...

class DialoguePanel(Panel):
    """Built-in dialogue panel of the story plugin. State: {dialogue, node, speaker,
    text, tags, options: [{index, speaker, text, enabled}]}; actions `next` and
    `choose(option: int)`. Restyle by subclassing with your own markup —
    `@ui("dialogue_box", html="ui/dialogue.html", modal=True, layer="overlay")
    class Box(DialoguePanel): ...` — and conversations open yours instead."""

VerbFn = Callable[[Context, ContentRef[QuestDef], QuestStep, float], bool | str]

def quest_verb(id: str, *, target: type[Any] | None = None,
               args: dict[str, type[Any]] | None = None) -> Callable[[VerbFn], VerbFn]:
    """A custom quest verb, evaluated every frame while a step using it is active:

    @quest_verb("deliver", target=EntityRef, args={"car": PrefabRef, "max_heat": int})
    def deliver(ctx, quest, step, dt) -> bool | str:
        ...   # False = not yet; True = complete; a string = complete with that outcome
              # (branch on it with next_if: {"outcome": "rushed", "goto": [...]})
    `target`/`args` declare what quest files may write; the checker validates them.
    Keep verbs side-effect free: rewards and world changes belong in handlers of
    QuestStepCompleted. Progress that must survive a save goes in a resource."""

def dialogue_command(name: str) -> Callable[[Callable[..., None]], Callable[..., None]]:
    """Expose a function to .yarn as <<name args>>. Signature: (ctx, *typed args)."""
