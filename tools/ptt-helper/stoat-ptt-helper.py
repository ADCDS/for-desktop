#!/usr/bin/python3
"""Stoat push-to-talk helper.

Global push-to-talk needs key press AND release while another window is
focused. Wayland offers no way to do that from an unprivileged app: the
GlobalShortcuts portal only binds shortcuts for sandboxed apps it can
identify, KDE's kglobalaccel has no release event, and XRecord is blind to
Wayland input. Reading /dev/input works, but the usual way to allow it --
adding the account to the `input` group -- lets *every* program that account
runs read *every* keystroke.

So this runs as root and deliberately does almost nothing: it watches a single
keycode and forwards its press/release over a unix socket. Every other key is
dropped inside the read loop; nothing else is buffered, logged or forwarded.

Protocol (newline-delimited JSON in, single chars out):
    client -> {"watch": 56}   select the Linux KEY_* code to watch
    server -> "1\\n" / "0\\n"  press / release of that key

Deliberately stdlib-only: the service runs with ProtectHome=yes, so a runtime
living under /home (nvm, pyenv) would be invisible to it.
"""

import errno
import json
import os
import selectors
import socket
import struct
import sys
import time

SOCKET_PATH = os.environ.get("STOAT_PTT_SOCKET", "/run/stoat-ptt.sock")
OWNER_UID = int(os.environ.get("STOAT_PTT_UID", "-1"))
BY_PATH = "/dev/input/by-path"

# struct input_event on 64-bit Linux: timeval (16) + type (2) + code (2) + value (4)
EVENT_FORMAT = "llHHi"
EVENT_SIZE = struct.calcsize(EVENT_FORMAT)
EV_KEY = 1

watched_key = -1
clients: set[socket.socket] = set()


def log(*args):
    print(time.strftime("%H:%M:%S"), *args, flush=True)


def discover_keyboards():
    """Resolve every *-event-kbd alias to its real device, de-duplicated."""
    devices = []
    seen = set()
    try:
        entries = sorted(os.listdir(BY_PATH))
    except OSError as err:
        log("cannot list", BY_PATH, err)
        return devices

    for entry in entries:
        if not entry.endswith("-event-kbd"):
            continue
        real = os.path.realpath(os.path.join(BY_PATH, entry))
        if real in seen:
            continue
        seen.add(real)
        devices.append(real)
    return devices


def broadcast(state: int):
    line = b"1\n" if state else b"0\n"
    for client in list(clients):
        try:
            client.sendall(line)
        except OSError:
            clients.discard(client)


def handle_device(fileobj):
    global watched_key
    try:
        data = fileobj.read(EVENT_SIZE)
    except BlockingIOError:
        return
    except OSError as err:
        log("read error:", err)
        return
    if not data or len(data) < EVENT_SIZE:
        return

    _, _, ev_type, code, value = struct.unpack(EVENT_FORMAT, data)
    if ev_type != EV_KEY:
        return
    if code != watched_key:
        # Discarded here: unrelated keys are never stored or forwarded.
        return
    # value 2 is autorepeat while held; only the edges matter.
    if value == 1:
        broadcast(1)
    elif value == 0:
        broadcast(0)


def handle_client_data(conn, buffers):
    global watched_key
    try:
        chunk = conn.recv(4096)
    except OSError:
        chunk = b""

    if not chunk:
        clients.discard(conn)
        buffers.pop(conn, None)
        selector.unregister(conn)
        conn.close()
        # Nobody listening -> watch nothing at all.
        if not clients:
            watched_key = -1
            log("no clients; watching nothing")
        return

    buffers[conn] = buffers.get(conn, b"") + chunk
    while b"\n" in buffers[conn]:
        line, buffers[conn] = buffers[conn].split(b"\n", 1)
        if not line.strip():
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if isinstance(message.get("watch"), int):
            watched_key = message["watch"] if message["watch"] >= 0 else -1
            log("watching keycode", watched_key)


keyboards = discover_keyboards()
if not keyboards:
    log("no keyboards found under", BY_PATH)
    sys.exit(1)

selector = selectors.DefaultSelector()

for path in keyboards:
    try:
        handle = open(path, "rb", buffering=0)
    except OSError as err:
        log("cannot open", path, err)
        continue
    os.set_blocking(handle.fileno(), False)
    selector.register(handle, selectors.EVENT_READ, ("device", handle))
    log("watching", path)

try:
    os.unlink(SOCKET_PATH)
except OSError as err:
    if err.errno != errno.ENOENT:
        log("could not remove stale socket:", err)

server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(SOCKET_PATH)
server.listen(4)
os.chmod(SOCKET_PATH, 0o600)
if OWNER_UID >= 0:
    try:
        os.chown(SOCKET_PATH, OWNER_UID, -1)
    except OSError as err:
        log("chown failed:", err)
selector.register(server, selectors.EVENT_READ, ("server", server))
log("listening on", SOCKET_PATH, "uid", OWNER_UID)

client_buffers: dict[socket.socket, bytes] = {}

try:
    while True:
        for key, _ in selector.select():
            kind, obj = key.data
            if kind == "device":
                handle_device(obj)
            elif kind == "server":
                conn, _ = obj.accept()
                conn.setblocking(False)
                clients.add(conn)
                selector.register(conn, selectors.EVENT_READ, ("client", conn))
                log("client connected")
            else:
                handle_client_data(obj, client_buffers)
except KeyboardInterrupt:
    pass
finally:
    try:
        os.unlink(SOCKET_PATH)
    except OSError:
        pass
