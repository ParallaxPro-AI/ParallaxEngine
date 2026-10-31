import { describe, expect, it, vi } from 'vitest';
import { createEditorHost, HostEvents, whenEditorReady } from './host.js';
import type { CameraMode, EditorEventSource, EditorHost, HostParts } from './host.js';
import type { SessionMode } from './session/index.js';
import type { EntityId } from '@parallax/runtime/core';

/** A fake editor: the fields HostEvents reads, and `emit` to announce a change. */
function fakeEditor() {
  const listeners = new Set<(changes: ReadonlySet<string>) => void>();
  const state = {
    selection: [] as EntityId[],
    mode: 'edit' as SessionMode,
    scene: 'main',
    dirty: [] as string[],
    saving: false,
  };
  const source: EditorEventSource = {
    on: (l) => { listeners.add(l); return () => listeners.delete(l); },
    get saving() { return state.saving; },
    session: {
      get selection() { return state.selection; },
      get mode() { return state.mode; },
      get scene() { return state.scene; },
      documents: { dirty: () => state.dirty },
    },
  };
  const emit = (): void => { for (const l of listeners) l(new Set(['documents'])); };
  return { state, source, emit, listeners };
}

/** A layout with nothing to report (tests that don't touch the side panel). */
const NO_LAYOUT = { panelsOpen: false, onPanelsChange: () => () => {} };

describe('HostEvents', () => {
  it('fires selection, mode and scene only when they change', () => {
    const fake = fakeEditor();
    const events = new HostEvents(fake.source);
    const selection = vi.fn();
    const mode = vi.fn();
    const scene = vi.fn();
    events.on('selection', selection);
    events.on('mode', mode);
    events.on('scene', scene);

    fake.emit();
    expect(selection).not.toHaveBeenCalled();
    fake.state.selection = [3 as EntityId];
    fake.emit();
    fake.emit();
    expect(selection).toHaveBeenCalledTimes(1);
    expect(selection).toHaveBeenCalledWith({ ids: [3] });

    fake.state.mode = 'playing';
    fake.emit();
    expect(mode).toHaveBeenCalledWith({ mode: 'playing' });
    fake.state.scene = 'level2';
    fake.emit();
    expect(scene).toHaveBeenCalledWith({ scene: 'level2' });
  });

  it('reports a save as what was dirty when it started and is clean after', () => {
    const fake = fakeEditor();
    const events = new HostEvents(fake.source);
    const save = vi.fn();
    const documents = vi.fn();
    events.on('save', save);
    events.on('documents', documents);

    fake.state.dirty = ['scenes/main.scene.json', 'prefabs/a.prefab.json'];
    fake.emit();
    expect(documents).toHaveBeenLastCalledWith({ dirty: ['prefabs/a.prefab.json', 'scenes/main.scene.json'] });

    fake.state.saving = true;
    fake.emit();
    fake.state.saving = false;
    fake.state.dirty = ['prefabs/a.prefab.json'];
    fake.emit();
    expect(save).toHaveBeenCalledWith({ saved: ['scenes/main.scene.json'], failed: true });
    expect(documents).toHaveBeenLastCalledWith({ dirty: ['prefabs/a.prefab.json'] });
  });

  it('a disposer stops one listener; a throwing listener does not stop the others', () => {
    const fake = fakeEditor();
    const events = new HostEvents(fake.source);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const gone = vi.fn();
    const after = vi.fn();
    const stop = events.on('mode', gone);
    events.on('mode', () => { throw new Error('host bug'); });
    events.on('mode', after);
    stop();
    fake.state.mode = 'paused';
    fake.emit();
    expect(gone).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledOnce();
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
    events.dispose();
    expect(fake.listeners.size).toBe(0);
  });
});

describe('the camera mode', () => {
  /** The viewport's camera toggle: a change announces itself as an editor change, as Viewport's does. */
  function fakeCamera(emit: () => void) {
    const camera = {
      cameraMode: 'orbit' as CameraMode,
      setCameraMode: vi.fn((mode: CameraMode) => {
        if (mode === camera.cameraMode) return;
        camera.cameraMode = mode;
        emit();
      }),
    };
    return camera;
  }

  it('a host reads and sets it, and hears each change once, whoever made it', () => {
    const fake = fakeEditor();
    const camera = fakeCamera(fake.emit);
    // Just the parts createEditorHost touches here: no bottom-panel tab bar, a toolbar's Publish.
    const parts = {
      editor: fake.source, layout: NO_LAYOUT, toolbar: { setPublishAction: () => {} }, bottom: { el: { querySelector: () => null } },
      camera, defaultPublish: () => {},
    } as unknown as HostParts;
    const host = createEditorHost(parts);
    const heard = vi.fn();
    host.on('camera', heard);
    expect(host.cameraMode).toBe('orbit');

    host.setCameraMode('fly');
    expect(camera.setCameraMode).toHaveBeenCalledWith('fly');
    expect(host.cameraMode).toBe('fly');
    expect(heard).toHaveBeenCalledWith({ mode: 'fly' });
    host.setCameraMode('fly');
    fake.emit();
    expect(heard).toHaveBeenCalledOnce();

    camera.setCameraMode('orbit'); // the top bar's toggle, or F
    expect(heard).toHaveBeenLastCalledWith({ mode: 'orbit' });
    expect(host.cameraMode).toBe('orbit');

    expect(() => host.setCameraMode('walk' as CameraMode)).toThrow(/'orbit' or 'fly'/);
    expect(host.cameraMode).toBe('orbit');
  });

  it('without a viewport camera it stays orbit', () => {
    const fake = fakeEditor();
    const host = createEditorHost({
      editor: fake.source, layout: NO_LAYOUT, toolbar: { setPublishAction: () => {} }, bottom: { el: { querySelector: () => null } },
      defaultPublish: () => {},
    } as unknown as HostParts);
    host.setCameraMode('fly');
    expect(host.cameraMode).toBe('orbit');
  });
});

describe('the logo and the project name', () => {
  it("hand a host's logo and rename actions to the top bar", async () => {
    const fake = fakeEditor();
    const toolbar = { setPublishAction: () => {}, setLogoAction: vi.fn(), setRenameAction: vi.fn(), renameProject: vi.fn(async () => true) };
    const host = createEditorHost({
      editor: fake.source, layout: NO_LAYOUT, toolbar, bottom: { el: { querySelector: () => null } }, defaultPublish: () => {},
    } as unknown as HostParts);
    const logo = { href: '/projects', title: 'Back to Projects' };
    host.setLogoAction(logo);
    expect(toolbar.setLogoAction).toHaveBeenCalledWith(logo);
    host.setLogoAction(null);
    expect(toolbar.setLogoAction).toHaveBeenLastCalledWith(null);
    const rename = vi.fn();
    host.setRenameAction(rename);
    expect(toolbar.setRenameAction).toHaveBeenCalledWith(rename);
    expect(await host.renameProject()).toBe(true);
    host.setRenameAction(null);
    expect(toolbar.setRenameAction).toHaveBeenLastCalledWith(null);
  });
});

describe('whenEditorReady', () => {
  it('runs at once when the host exists, else on parallax-editor-ready', () => {
    // A page's window is an EventTarget; Node's globalThis is not.
    const target = new EventTarget();
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { add: g['addEventListener'], remove: g['removeEventListener'], dispatch: g['dispatchEvent'] };
    g['addEventListener'] = target.addEventListener.bind(target);
    g['removeEventListener'] = target.removeEventListener.bind(target);
    g['dispatchEvent'] = target.dispatchEvent.bind(target);
    const page = globalThis as { parallaxEditorHost?: EditorHost };
    const host = { apiVersion: 1 } as EditorHost;
    const later = vi.fn();
    const cancel = whenEditorReady(later);
    globalThis.dispatchEvent(new CustomEvent('parallax-editor-ready', { detail: { host } }));
    expect(later).toHaveBeenCalledWith(host);
    globalThis.dispatchEvent(new CustomEvent('parallax-editor-ready', { detail: { host } }));
    expect(later).toHaveBeenCalledOnce();
    cancel();

    page.parallaxEditorHost = host;
    const now = vi.fn();
    whenEditorReady(now);
    expect(now).toHaveBeenCalledWith(host);
    delete page.parallaxEditorHost;
    g['addEventListener'] = saved.add;
    g['removeEventListener'] = saved.remove;
    g['dispatchEvent'] = saved.dispatch;
  });
});

describe('the side panel', () => {
  /** The layout's panels toggle, as EditorLayout keeps it: a change tells its listeners. */
  function fakeLayout() {
    const listeners = new Set<() => void>();
    const layout = {
      panelsOpen: true,
      onPanelsChange: (l: () => void) => { listeners.add(l); return () => listeners.delete(l); },
      setPanelsOpen: vi.fn((open: boolean) => {
        layout.panelsOpen = open;
        for (const l of listeners) l();
      }),
      togglePanels: () => { layout.setPanelsOpen(!layout.panelsOpen); return layout.panelsOpen; },
      changed: () => { for (const l of listeners) l(); },
    };
    return layout;
  }

  it('a host shows, hides and toggles it, and hears each actual change once', () => {
    const fake = fakeEditor();
    const layout = fakeLayout();
    const host = createEditorHost({
      editor: fake.source, layout, toolbar: { setPublishAction: () => {} }, bottom: { el: { querySelector: () => null } },
      defaultPublish: () => {},
    } as unknown as HostParts);
    const heard = vi.fn();
    host.on('side', heard);
    expect(host.sideOpen).toBe(true);

    expect(host.toggleSide()).toBe(false);
    expect(host.sideOpen).toBe(false);
    expect(heard).toHaveBeenLastCalledWith({ open: false });
    host.setSideOpen(true);
    expect(heard).toHaveBeenLastCalledWith({ open: true });
    expect(heard).toHaveBeenCalledTimes(2);

    layout.changed(); // e.g. a mount or a rotation that left it as it was
    expect(heard).toHaveBeenCalledTimes(2);
    layout.panelsOpen = false; // a phone rotated to landscape: the sheet starts closed
    layout.changed();
    expect(heard).toHaveBeenLastCalledWith({ open: false });
    expect(heard).toHaveBeenCalledTimes(3);
  });
});
