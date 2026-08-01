/**
 * The IPC contract between the main process and both renderers.
 *
 * Kept in one file, imported by main.js and by the preload scripts, so a renamed
 * channel breaks at import time instead of silently doing nothing at runtime.
 */

export const CHANNELS = {
  // main -> renderer (pushes)
  SNAPSHOT: 'overlay:snapshot',
  STATUS: 'overlay:status',
  CONFIG_CHANGED: 'config:changed',
  TOAST: 'overlay:toast',
  LOCK_CHANGED: 'overlay:lock-changed',
  HOVER: 'overlay:hover',
  /** 'below' (the usual) or 'above', when the window is against the bottom of the screen. */
  PANEL_SIDE: 'overlay:panel-side',

  // renderer -> main (invoke, returns a value)
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  LOGS_LIST: 'logs:list',
  LOGS_PICK: 'logs:pick',
  LOGS_VALIDATE: 'logs:validate',
  SETUP_COMPLETE: 'setup:complete',
  OPEN_SETTINGS: 'window:open-settings',

  // renderer -> main (fire and forget)
  SET_IGNORE_MOUSE: 'window:set-ignore-mouse',
  FIT_HEIGHT: 'window:fit-height',
  CLOSE_WINDOW: 'window:close',
  RESET_ENCOUNTER: 'overlay:reset',
  TOGGLE_LOCK: 'overlay:toggle-lock',
  TOGGLE_METRIC: 'overlay:toggle-metric',
};

/**
 * Snapshots are pushed at this rate, not on every log line.
 *
 * A busy raid produces hundreds of lines per second; forwarding each one would spend
 * the whole frame budget on IPC and structured cloning. 4 Hz is well past the point
 * where a DPS number reads as live.
 */
export const PUSH_HZ = 4;
export const PUSH_INTERVAL_MS = 1000 / PUSH_HZ;
