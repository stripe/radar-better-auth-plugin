export const RADAR_SESSION_HEADER = "x-stripe-radar-session";
export const protectedPaths = [
  "/sign-up/email",
  "/sign-in/email",
  "/sign-in/social",
] as const;

export function isSocialCallback(path: string | undefined) {
  return !!path && /^\/callback\/[^/]+$/.test(path);
}

export function isProtectedPath(path: string | undefined) {
  return (
    protectedPaths.some((entry) => entry === path) || isSocialCallback(path)
  );
}
