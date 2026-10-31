/**
 * @parallax/editor/session — what editors, the play page and the AI game builder need from
 * the engine, on top of a running game:
 *
 *   EditorSession        edit mode, selection, gizmo drags, write-back with undo, play / stop,
 *                        pause, step, time scale, hot reload, profiling, observation
 *   ProjectDocuments     the project's files, edited by JSON patches (undo = inverse patches)
 *   gizmo / picking      pure math over what the renderer drew (usable without a session)
 *   Profiler + budgets   kernel frame samples as a stream; PP5020 budget asserts
 *   observe              the AI builder's view of a game (contracts/observation.schema.json)
 *   openHeadlessEditor   a session on the headless platform (tests, Node tools)
 *
 * The page side (DOM control inspection, pixel capture, automation hooks) is `./browser`.
 */

export { addPlacementPatch, checkField, fieldPatch, paramPatch, removePlacementPatch, revertPatch, tidy, transformPatch } from './write_back.js';
export type { EditTarget, LocalTransform } from './write_back.js';
export { addComponentPatch, componentValuesPatch, defaultFields, defaultJson, environmentPatch, nameKey, placeholderJson, removeComponentPatch, renamePatch, requiredFields } from './component_ops.js';
export { asObject, getAt, parsePointer, pointerOf, ProjectDocuments } from './documents.js';
export type { FilePatch, JsonOp } from './documents.js';
export { boundsOf, drawnFrame, viewOf, worldCorners } from './drawn.js';
export type { Box3, Drawn, Drawn2d, Drawn3d, DrawnFrame } from './drawn.js';
export { axisAngle, GizmoDrag, gizmoAxes, gizmoHandles, handlesFor, hitHandle } from './gizmo.js';
export type { GizmoDragInit, GizmoHandle, GizmoLayout, GizmoMode, GizmoSpace, HandleShape, Pose, Snap } from './gizmo.js';
export { openHeadlessEditor } from './headless.js';
export type { HeadlessEditor, HeadlessEditorOptions } from './headless.js';
export { EditHistory } from './history.js';
export type { Edit } from './history.js';
export { jsonSafe, observe, OBSERVATION_FORMAT, OBSERVATION_VERSION } from './observe.js';
export type {
  ObservedAction, ObservedCamera, ObservedControl, ObservedEntity, ObservedPanel, Observation, ObserveOptions,
} from './observe.js';
export { hitDistance, pick, pickRay, pickRect, screenBoxes } from './picking.js';
export type { PickHit, PickOptions } from './picking.js';
export { assertBudget, checkBudget, memoryEstimate, Profiler, runtimeMemory, worldCounts } from './profiler.js';
export type {
  Budget, HookStats, Limit, Measured, MemoryEstimate, ProfilerOptions, ProfileStats, Summary, UnitStats, WorldCounts,
} from './profiler.js';
export { ensurePrefab, ID, inheritedFrom, PRIMITIVE_KINDS, primitive, toId, transformFields, uniqueId } from './entity_ops.js';
export type { EntryCopy, Primitive, PrimitiveKind } from './entity_ops.js';
export { EditorSession } from './session.js';
export type { CameraPose, EditorSessionOptions, ReloadResult, SessionHost, SessionMode } from './session.js';
export { mapSources } from './sources.js';
export type { ChildSource, EntitySource, PlacementSource, SourceMap } from './sources.js';
export { view2d, view3d } from './view_math.js';
export type { PixelRect, Ray, ScreenPoint, ScreenView } from './view_math.js';
