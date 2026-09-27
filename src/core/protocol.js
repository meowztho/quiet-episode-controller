export const PROTOCOL_VERSION = 1;

export const MessageType = Object.freeze({
  GET_STATUS: "POPUP_GET_STATUS",
  START: "POPUP_START",
  STOP: "POPUP_STOP",
  PERMISSION_GRANTED: "POPUP_PERMISSION_GRANTED",
  SITE_PROBE: "SITE_PROBE",
  PROVIDER_ATTACH: "PROVIDER_ATTACH",
  PROVIDER_STOP: "PROVIDER_STOP",
  PROVIDER_PROBE: "PROVIDER_PROBE",
  MEDIA_FOUND: "MEDIA_FOUND",
  MEDIA_PLAYING: "MEDIA_PLAYING",
  MEDIA_ENDED: "MEDIA_ENDED",
  MEDIA_ERROR: "MEDIA_ERROR",
  MEDIA_STALLED: "MEDIA_STALLED",
  MEDIA_PLAY_BLOCKED: "MEDIA_PLAY_BLOCKED",
  MEDIA_REPLACED: "MEDIA_REPLACED"
});

export const SessionState = Object.freeze({
  IDLE: "IDLE",
  ARMING: "ARMING",
  RUNNING: "RUNNING",
  NAVIGATING: "NAVIGATING",
  BLOCKED: "BLOCKED",
  STOPPED: "STOPPED",
  COMPLETED: "COMPLETED"
});

export function envelope(type, payload = {}, session = null) {
  return {
    version: PROTOCOL_VERSION,
    sessionId: session?.sessionId ?? null,
    epoch: session?.epoch ?? null,
    type,
    payload
  };
}

export function isEnvelope(message) {
  return Boolean(
    message &&
    message.version === PROTOCOL_VERSION &&
    typeof message.type === "string" &&
    message.payload &&
    typeof message.payload === "object"
  );
}
