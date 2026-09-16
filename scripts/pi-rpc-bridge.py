#!/usr/bin/env python3
"""Bridge a TCP socket to ``pi --mode rpc`` stdio inside the AgentVM guest.

The host reaches this server through an AgentVM port forward (host loopback ->
guest port), so the host can speak the RPC JSONL protocol to a pi process
running in the VM.

A pi process is spawned immediately ("warm") so its slow startup overlaps the
guest NIC coming up and the host connecting; the process is recycled when the
host disconnects.

Usage (inside the guest):
    python3 pi-rpc-bridge.py --port 7100 [--session PATH] [--name NAME] [--once]
"""

import argparse
import fcntl
import os
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time

LOG = "/workspace/.pi-box/rpc-bridge.log"
SIOCGIFADDR = 0x8915


def log(msg):
    line = "[%s] %s\n" % (time.strftime("%H:%M:%S"), msg)
    try:
        with open(LOG, "a") as f:
            f.write(line)
    except Exception:
        pass
    sys.stderr.write(line)
    sys.stderr.flush()


def iface_has_ipv4(iface):
    """Cheap, fork-free check for an IPv4 address on an interface."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        packed = struct.pack("256s", iface[:15].encode("utf-8"))
        res = fcntl.ioctl(s.fileno(), SIOCGIFADDR, packed)
        return socket.inet_ntoa(res[20:24]) != "0.0.0.0"
    except Exception:
        return False
    finally:
        s.close()


def wait_for_ip(iface, timeout):
    """Wait until the guest NIC has an IPv4 address.

    The host must not connect before the guest can receive the injected SYN, so
    the readiness marker is only published once eth0 is up. The startup script
    brings the NIC up in the background, so this may lag the bridge by a moment.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        if iface_has_ipv4(iface):
            return True
        time.sleep(0.1)
    return False


def spawn_pi(pi_args, cwd, env):
    return subprocess.Popen(
        pi_args,
        cwd=cwd,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=open(LOG, "ab", buffering=0),
    )


def sock_to_pipe(conn, w):
    """Host -> pi stdin."""
    try:
        while True:
            data = conn.recv(65536)
            if not data:
                break
            w.write(data)
            w.flush()
    except Exception as e:  # noqa: BLE001
        log("sock->pi: %s" % e)
    finally:
        try:
            w.close()
        except Exception:
            pass


def pipe_to_sock(r, conn):
    """pi stdout -> host.

    Use os.read() rather than r.read(65536): a buffered read() blocks until it
    has the full 64 KiB (or EOF), so a single JSON line from pi would never be
    forwarded. os.read() returns as soon as any bytes are available.
    """
    try:
        fd = r.fileno()
        while True:
            data = os.read(fd, 65536)
            if not data:
                break
            conn.sendall(data)
    except Exception as e:  # noqa: BLE001
        log("pi->sock: %s" % e)
    finally:
        try:
            conn.shutdown(socket.SHUT_WR)
        except Exception:
            pass


def main():
    global LOG
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--session", default=None)
    ap.add_argument("--name", default=None)
    ap.add_argument("--cwd", default="/workspace")
    ap.add_argument("--log", default=LOG)
    ap.add_argument("--once", action="store_true", help="exit after one connection")
    args = ap.parse_args()

    LOG = args.log

    env = dict(os.environ)
    env.setdefault("PI_CODING_AGENT_DIR", "/workspace/.pi")
    env.setdefault("PI_CODING_AGENT_SESSION_DIR", "/workspace/.pi/sessions")
    env.setdefault("PI_OFFLINE", "1")
    env.setdefault("PI_SKIP_VERSION_CHECK", "1")
    env.setdefault("PI_TELEMETRY", "0")
    env.setdefault("LANG", "C.UTF-8")

    pi_bin = shutil.which("pi") or "/usr/local/bin/pi"
    pi_args = [pi_bin, "--mode", "rpc", "--approve"]
    if args.session:
        pi_args += ["--session", args.session]
    if args.name:
        pi_args += ["--name", args.name]

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", args.port))
    srv.listen(4)
    log("listening on 0.0.0.0:%d (pid %d, pi=%s)" % (args.port, os.getpid(), pi_bin))

    # Warm pi before the NIC wait so its ~25s startup overlaps the network
    # coming up and the host connecting.
    proc = spawn_pi(pi_args, args.cwd, env)
    log("warmed pi pid %d: %s" % (proc.pid, " ".join(pi_args)))

    # Readiness marker for the host. AgentVM's port-forward listener accepts the
    # host connection immediately, so the host must not connect until the guest
    # side can receive the injected SYN. The file is on the workspace mount, so
    # the host can poll for it directly.
    if not wait_for_ip("eth0", 60):
        log("warning: eth0 has no IPv4 after 60s; publishing marker anyway")
    try:
        with open(LOG + ".ready", "w") as f:
            f.write(str(proc.pid))
    except Exception as e:  # noqa: BLE001
        log("could not write ready marker: %s" % e)

    while True:
        conn, addr = srv.accept()
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        log("client connected from %s:%d" % addr)

        t_in = threading.Thread(target=sock_to_pipe, args=(conn, proc.stdin), daemon=True)
        t_out = threading.Thread(target=pipe_to_sock, args=(proc.stdout, conn), daemon=True)
        t_in.start()
        t_out.start()
        t_out.join()
        log("client gone; recycling pi pid %d" % proc.pid)
        try:
            proc.terminate()
        except Exception:
            pass
        try:
            conn.close()
        except Exception:
            pass
        if args.once:
            break
        proc = spawn_pi(pi_args, args.cwd, env)
        log("warmed pi pid %d" % proc.pid)

    srv.close()


if __name__ == "__main__":
    main()
