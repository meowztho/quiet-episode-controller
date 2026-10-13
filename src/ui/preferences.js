// Popup preferences are persistent across browser restarts and QEC sessions.
const KEY = "qec.preferences";

export async function readFullscreenPreference(storage) {
  const values = await storage.get(KEY);
  const fullscreen = values?.[KEY]?.fullscreen;
  return typeof fullscreen === "boolean" ? fullscreen : true;
}

export async function writeFullscreenPreference(storage, fullscreen) {
  await storage.set({ [KEY]: { fullscreen: Boolean(fullscreen) } });
}
