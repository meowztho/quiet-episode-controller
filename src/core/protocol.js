export const PROTOCOL_VERSION = 1;

export const MessageType = Object.freeze({
  GET_STATUS: "POPUP_GET_STATUS",
  START: "POPUP_START",
  STOP: "POPUP_STOP",
  CAST_REMOTE_CONTROL: "POPUP_CAST_REMOTE_CONTROL",
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
  MEDIA_REPLACED: "MEDIA_REPLACED",
  CAST_STATUS: "CAST_STATUS",
  CAST_HANDOFF_REQUIRED: "CAST_HANDOFF_REQUIRED",
  CAST_HANDOFF_RESULT: "CAST_HANDOFF_RESULT",
  CAST_RELAY_ITEM: "CAST_RELAY_ITEM",
  CAST_RELAY_APPLY: "CAST_RELAY_APPLY",
  CAST_RELAY_PLAYING: "CAST_RELAY_PLAYING",
  CAST_RELAY_FAILED: "CAST_RELAY_FAILED",
  CAST_RELAY_PROMOTE: "CAST_RELAY_PROMOTE"
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

export const SessionLifecycle = Object.freeze({
  NONE: "NONE",
  ACTIVE: "ACTIVE",
  ENDED: "ENDED"
});

export const PlaybackAuthority = Object.freeze({
  NONE: "NONE",
  LOCAL: "LOCAL_PLAYER",
  CAST: "CAST"
});

export const CastRemoteAction = Object.freeze({
  TOGGLE_PLAY_PAUSE: "TOGGLE_PLAY_PAUSE",
  SEEK_RELATIVE: "SEEK_RELATIVE",
  SEEK_TO: "SEEK_TO",
  STOP: "STOP"
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
