const KEY = "qec.session";

export async function loadSession() {
  const result = await chrome.storage.session.get(KEY);
  return result[KEY] ?? null;
}

export async function saveSession(session) {
  if (session) {
    await chrome.storage.session.set({ [KEY]: session });
  } else {
    await chrome.storage.session.remove(KEY);
  }
  return session;
}

export const SESSION_STORAGE_KEY = KEY;
