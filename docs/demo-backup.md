# Offline backup recording

Insurance in case the laptop, the browser or the projector connection fails during the presentation.
The demo itself already runs fully offline (no network, no API keys); this covers a hardware or setup failure.

## Record it (once, the day before)

1. Fresh state: `npm ci && npm run sim -- --build`, then `npm run demo-check` (all 6 scenarios must PASS).
2. Start the dashboard: `npm run dev` and open http://localhost:3000 in a clean browser window (no bookmarks bar, zoom 100%, window about 1600x900 or full screen).
3. Open any screen recorder. **OBS Studio** works on every OS (free: add a "Display Capture" or "Window Capture" source, Settings → Output → Recording Format mp4). macOS QuickTime (File → New Screen Recording) or Windows Game Bar (Win + Alt + R) are fine too.
4. Record the 3-minute script in [demo-script.md](demo-script.md) at **4x speed**, speaking the lines, exactly as on stage. Do two takes and keep the better one.
5. Save the file as **`docs/demo-recording.mp4`**. It is gitignored (too large for the repo), so also copy it to a USB stick and to a cloud drive or phone.

## On the day

1. Right before presenting, run the smoke test: `npm run demo-check`. If anything FAILS, switch to the recording.
2. Keep `docs/demo-recording.mp4` open in a video player in a second window, paused at 0:00.
3. If the live demo breaks at any point: switch windows, play the recording from the matching timestamp (0:00 problem, 0:30 twin + gateway, 1:30 cutout + prior shift, 2:15 eval) and keep talking.
