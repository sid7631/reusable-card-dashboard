# Demo recorder

Lets a user capture a guided walkthrough of the app and export it as a single self-contained HTML reel.

## Using it

1. **Record demo** (sidebar) starts a session. A floating recorder bar stays on screen while you use the app
   normally — every page, filter, dialog and the assistant. Drag the bar by its grip to move it.
2. **Capture scene** — the first capture asks the browser for permission to share the screen; choose
   **this tab**. The recorder hides itself, grabs the screen, then lets you drag a region (or keep the whole
   screen). Use **3 s** to get time to open a menu or hover over something first.
3. Give the scene a title and caption. **+ Add image** captures more images for the same scene. Click the
   preview to choose where the camera zooms; pick *Zoom in*, *Zoom out* or *Still* and how long each image shows.
4. **Scenes** lists everything: drag or use the arrows to reorder, edit captions, re-capture or delete.
5. **Finish** → name the reel → **Preview** or **Download HTML**. The file holds every image, the player and
   its styles. It works offline and in any modern browser.

The reel plays like a slide show:
- scenes advance by themselves with a smooth zoom/pan between two camera positions, and captions on top;
- **Space** plays and pauses, **← / →** step, **Home / End** jump to the start or end, and **F** toggles full screen;
- clicking the progress track jumps to that point.

A recording is kept in this browser's IndexedDB, separately for each user, until it is ended or discarded.
It survives navigation, reloads and signing in again. **Nothing is uploaded.**

## How it works

| File | Role |
|---|---|
| `index.tsx` | The only thing the app imports: the sidebar launcher. Loads everything else lazily on first use |
| `RecorderSession.tsx` | Floating bar and capture flow. All recorder UI renders in one container on `<body>`, which is hidden while a frame is grabbed |
| `capture.ts` | Screen Capture API (`getDisplayMedia`, current tab preferred), fresh-frame grabbing, crop + WebP/JPEG encoding |
| `RegionSelect.tsx` | Drag-to-select on the frozen capture |
| `SceneEditor.tsx`, `SceneList.tsx`, `FinishDialog.tsx` | Editing UI |
| `useRecording.ts`, `persist.ts`, `types.ts` | State and IndexedDB storage |
| `exportReel.ts`, `player/reel.{js,css}` | Builds the HTML file. The player is plain JavaScript and CSS, inlined into every reel |

Clicks and key presses inside the recorder are stopped at its container, so the app's own handlers don't fire.
An open menu or dialog therefore stays open to be captured.

## Switching it off or removing it

- **Off without removing:** build with `VITE_DEMO_RECORDER=false`. The launcher and all recorder code are left
  out of the bundle.
- **Remove:** delete this folder and two lines in `src/App.tsx`: the `import DemoRecorder …` line and
  `<DemoRecorder collapsed={collapsed} />`. Nothing else in the app or the backend refers to it.

## Browser support

Screen capture needs a desktop browser: Chrome, Edge, Firefox or Safari. Chrome and Edge offer the current tab
directly. If the user shares a window or the whole screen instead, captures still work, because regions are
picked on the captured image, but they show whatever was visible there.
