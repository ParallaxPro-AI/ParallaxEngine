/**
 * `parallax.viewmodel` (sdk/parallax/viewmodel.pyi): the Viewmodel and ViewmodelItem handles,
 * the Recoil / PoseKey / PoseCue / ViewPose records, the ViewmodelCue event and the
 * `viewmodel()` factory `parallax.plugins` re-exports.
 */

import type { KernelPlugin } from '../function/kernel/index.js';
import {
  POSE_CUE_RECORD, POSE_KEY_RECORD, RECOIL_RECORD, VIEW_POSE_RECORD, VIEWMODEL, VIEWMODEL_CUE, VIEWMODEL_ITEM, VIEWMODEL_ITEM_SCHEMA,
  VIEWMODEL_SCHEMA, viewmodel as viewmodelPlugin,
} from '../function/plugins/viewmodel/index.js';
import { schemaRecord } from './characters.js';
import { eventHandle } from './events.js';
import { componentHandle } from './handles.js';
import { bindArgs } from './kwargs.js';

/** On an entity under the first-person camera: item, arms, layers; fire / aim / play. */
export const Viewmodel = componentHandle({ id: VIEWMODEL, schema: VIEWMODEL_SCHEMA }, 'Viewmodel');
/** On a held item's prefab: hip pose, sight, grips, recoil. */
export const ViewmodelItem = componentHandle({ id: VIEWMODEL_ITEM, schema: VIEWMODEL_ITEM_SCHEMA }, 'ViewmodelItem');

export const Recoil = schemaRecord('Recoil', RECOIL_RECORD);
export const PoseKey = schemaRecord('PoseKey', POSE_KEY_RECORD);
export const PoseCue = schemaRecord('PoseCue', POSE_CUE_RECORD);
export const ViewPose = schemaRecord('ViewPose', VIEW_POSE_RECORD, { keys: PoseKey, cues: PoseCue });

/** `@on(ViewmodelCue)`: entity (the viewmodel), pose, cue. */
export const ViewmodelCue = eventHandle(VIEWMODEL_CUE, 'ViewmodelCue');

/** `parallax.plugins.viewmodel()`. */
export function viewmodel(...args: unknown[]): KernelPlugin {
  bindArgs('viewmodel', args, {});
  return viewmodelPlugin();
}
