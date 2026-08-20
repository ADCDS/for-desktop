/* eslint-disable @typescript-eslint/no-explicit-any */
import net from "node:net";

import { ipcMain } from "electron";

import { mainWindow } from "./window";

/**
 * Global push-to-talk.
 *
 * Electron's globalShortcut only fires on press, never release (electron#26301),
 * so it cannot express hold-to-talk. Each platform needs its own source of raw
 * key events:
 *
 *  - Linux: a small root helper (tools/ptt-helper) reads /dev/input and
 *    forwards a single keycode over a unix socket. Wayland gives an
 *    unprivileged app no other option -- the GlobalShortcuts portal only binds
 *    for sandboxed apps it can identify, kglobalaccel has no release event, and
 *    XRecord cannot see Wayland input.
 *  - Windows/macOS: uiohook-napi, loaded lazily so its absence just downgrades
 *    to focused-only push-to-talk instead of breaking startup.
 *
 * All backends converge on emit(), which pushes to the renderer. The renderer
 * also listens for plain DOM key events, so push-to-talk still works while
 * focused even when no backend is available.
 */

const SOCKET_PATH = "/run/stoat-ptt.sock";

let currentCode = "";
let transmitting = false;

/** Tell the renderer the key went down (true) or up (false) */
function emit(pressed: boolean) {
  // The helper can deliver an unpaired release if the key was already held
  // when we connected; collapsing duplicates keeps the renderer honest.
  if (pressed === transmitting) return;
  transmitting = pressed;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("pushToTalk", pressed);
  }
}

/**
 * KeyboardEvent.code -> Linux input-event-codes KEY_*.
 *
 * Only the keys people actually bind for push-to-talk. Unmapped keys report as
 * unsupported rather than silently never firing.
 */
const LINUX_KEYCODES: Record<string, number> = {
  // modifiers
  AltLeft: 56, AltRight: 100, ControlLeft: 29, ControlRight: 97,
  ShiftLeft: 42, ShiftRight: 54, MetaLeft: 125, MetaRight: 126,
  CapsLock: 58, NumLock: 69, ScrollLock: 70,
  // whitespace / editing
  Space: 57, Tab: 15, Enter: 28, Backspace: 14, Escape: 1,
  Insert: 110, Delete: 111, Home: 102, End: 107, PageUp: 104, PageDown: 109,
  ArrowUp: 103, ArrowDown: 108, ArrowLeft: 105, ArrowRight: 106,
  // letters
  KeyA: 30, KeyB: 48, KeyC: 46, KeyD: 32, KeyE: 18, KeyF: 33, KeyG: 34,
  KeyH: 35, KeyI: 23, KeyJ: 36, KeyK: 37, KeyL: 38, KeyM: 50, KeyN: 49,
  KeyO: 24, KeyP: 25, KeyQ: 16, KeyR: 19, KeyS: 31, KeyT: 20, KeyU: 22,
  KeyV: 47, KeyW: 17, KeyX: 45, KeyY: 21, KeyZ: 44,
  // digits row
  Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6,
  Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
  Minus: 12, Equal: 13, BracketLeft: 26, BracketRight: 27, Backslash: 43,
  Semicolon: 39, Quote: 40, Backquote: 41, Comma: 51, Period: 52, Slash: 53,
  // function row
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66,
  F9: 67, F10: 68, F11: 87, F12: 88,
  F13: 183, F14: 184, F15: 185, F16: 186, F17: 187, F18: 188,
  F19: 189, F20: 190, F21: 191, F22: 192, F23: 193, F24: 194,
  // numpad -- popular for push-to-talk because nothing else uses it
  Numpad0: 82, Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad4: 75,
  Numpad5: 76, Numpad6: 77, Numpad7: 71, Numpad8: 72, Numpad9: 73,
  NumpadDecimal: 83, NumpadAdd: 78, NumpadSubtract: 74,
  NumpadMultiply: 55, NumpadDivide: 98, NumpadEnter: 96,
};

/* ------------------------------------------------------------------ linux */

let socket: net.Socket | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
let helperAvailable = false;

function linuxWatch(code: string) {
  const keycode = LINUX_KEYCODES[code];
  if (!socket || socket.destroyed) return;
  socket.write(JSON.stringify({ watch: keycode ?? -1 }) + "\n");
}

/**
 * Connect to the helper.
 *
 * Resolves once we know whether the helper is actually there, so setBinding
 * can report support truthfully instead of racing the connect callback.
 */
function linuxConnect(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const sock = net.connect(SOCKET_PATH);
    socket = sock;

    sock.on("connect", () => {
      helperAvailable = true;
      console.info("push-to-talk: connected to helper");
      if (currentCode) linuxWatch(currentCode);
      settle(true);
    });

    let buffer = "";
    sock.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line === "1") emit(true);
        else if (line === "0") emit(false);
      }
    });

    const retry = () => {
      sock.removeAllListeners();
      if (socket === sock) socket = undefined;
      // Never leave the mic hot because the helper vanished mid-press.
      emit(false);
      settle(false);
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        if (currentCode) linuxConnect();
      }, 5000);
    };

    // Helper not installed is the normal case on a stock system, not an error
    // worth shouting about; push-to-talk just stays focused-only.
    sock.on("error", () => {
      helperAvailable = false;
      retry();
    });
    sock.on("close", retry);
  });
}

/* -------------------------------------------------------- windows / macos */

let uiohook: any;
let uiohookStarted = false;

/**
 * KeyboardEvent.code -> uiohook keycode.
 *
 * Derived from the library's own UiohookKey export rather than hand-copied, so
 * it cannot drift. Most names already match KeyboardEvent.code; the rest are
 * spelled out below (uiohook uses unsided names for the left-hand modifiers,
 * and bare digits/letters where the DOM says Digit1/KeyA).
 */
const UIOHOOK_ALIASES: Record<string, string> = {
  AltLeft: "Alt",
  ControlLeft: "Ctrl",
  ShiftLeft: "Shift",
  MetaLeft: "Meta",
};

function uiohookCodeFor(code: string): number | undefined {
  if (!uiohook) return undefined;
  const table = uiohook.UiohookKey as Record<string, number>;
  if (!table) return undefined;

  const candidates = [
    UIOHOOK_ALIASES[code],
    code,
    code.startsWith("Key") ? code.slice(3) : undefined,
    code.startsWith("Digit") ? code.slice(5) : undefined,
  ];
  for (const name of candidates) {
    if (name && table[name] !== undefined) return table[name];
  }
  return undefined;
}

function hookStart(code: string): boolean {
  if (!uiohook) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      uiohook = require("uiohook-napi");
    } catch {
      console.info(
        "push-to-talk: uiohook-napi unavailable; falling back to focused-only",
      );
      return false;
    }
  }

  const keycode = uiohookCodeFor(code);
  if (keycode === undefined) return false;

  if (!uiohookStarted) {
    uiohook.uIOhook.on("keydown", (event: any) => {
      if (event.keycode === uiohookCodeFor(currentCode)) emit(true);
    });
    uiohook.uIOhook.on("keyup", (event: any) => {
      if (event.keycode === uiohookCodeFor(currentCode)) emit(false);
    });
    try {
      uiohook.uIOhook.start();
      uiohookStarted = true;
    } catch (err) {
      // macOS throws here until Input Monitoring is granted.
      console.info("push-to-talk: could not start key hook:", err);
      return false;
    }
  }
  return true;
}

/* -------------------------------------------------------------------- api */

export function initPushToTalk() {
  ipcMain.handle("setPushToTalkBinding", async (_event, code: string) => {
    currentCode = typeof code === "string" ? code : "";

    // Unbinding: stop transmitting and stop watching.
    if (!currentCode) {
      emit(false);
      if (process.platform === "linux") linuxWatch("");
      return process.platform === "linux" ? helperAvailable : uiohookStarted;
    }

    if (process.platform === "linux") {
      if (!(currentCode in LINUX_KEYCODES)) return false;
      // Await the connect so the answer reflects reality rather than racing it.
      if (!socket) return await linuxConnect();
      linuxWatch(currentCode);
      return helperAvailable;
    }

    return hookStart(currentCode);
  });
}
