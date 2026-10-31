/**
 * What the story plugin offers other code, and what it needs from it: the `story` and
 * `dialogue_input` services, declared in function/services/story.ts (shared with the
 * plugins that follow the story, such as streaming's world layers).
 */

export { DIALOGUE_INPUT_SERVICE, STORY_SERVICE } from '../../services/index.js';
export type { DialogueInput, QuestMarker, StoryService } from '../../services/index.js';
