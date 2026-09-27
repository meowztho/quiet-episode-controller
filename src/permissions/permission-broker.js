export function permissionPatternForOrigin(origin) {
  const url = new URL(origin);
  if (!/^https?:$/.test(url.protocol)) throw new TypeError("Only http(s) provider origins are supported");
  return `${url.protocol}//${url.hostname}/*`;
}

export async function getPermissionState(origin) {
  const pattern = permissionPatternForOrigin(origin);
  const granted = await chrome.permissions.contains({ origins: [pattern] });
  return { state: granted ? "GRANTED" : "REQUIRED", pattern };
}
