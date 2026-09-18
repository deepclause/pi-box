#!/usr/bin/env python3
"""Bouncing-ball demo for the AgentVM virtual framebuffer (/dev/fb0).

Arrow keys nudge the ball, space recentres it, Esc quits. Only the ball's
bounding box is repainted each frame, so the host gets small damage rects.
"""
import mmap
import os
import select
import struct
import time

W, H = 1024, 768
R = 18
STRIDE = W * 4

EV_KEY = 0x01
KEY_ESC, KEY_SPACE = 1, 57
KEY_UP, KEY_LEFT, KEY_RIGHT, KEY_DOWN = 103, 105, 106, 108


def rgb(r, g, b, a=255):
    # a8r8g8b8 little-endian: bytes are B, G, R, A
    return bytes((b, g, r, a))


def main():
    fb = open('/dev/fb0', 'r+b', buffering=0)
    m = mmap.mmap(fb.fileno(), W * H * 4)
    try:
        kbd = os.open('/dev/input/event0', os.O_RDONLY | os.O_NONBLOCK)
    except OSError:
        kbd = -1

    bg = rgb(12, 12, 16)
    ball = rgb(90, 200, 255)
    m[:] = bg * (W * H)

    x, y = W // 2, H // 2
    vx, vy = 6, 5
    prev = (x - R, y - R, 2 * R, 2 * R)

    def disc(cx, cy):
        for dy in range(-R, R + 1):
            span = int((R * R - dy * dy) ** 0.5)
            row = (cy + dy) * STRIDE + (cx - span) * 4
            m[row:row + (2 * span + 1) * 4] = ball * (2 * span + 1)

    def blank(bx, by, bw, bh):
        for j in range(by, by + bh):
            row = j * STRIDE + bx * 4
            m[row:row + bw * 4] = bg * bw

    running = True
    while running:
        if kbd >= 0:
            while select.select([kbd], [], [], 0)[0]:
                data = os.read(kbd, 24)
                if len(data) < 24:
                    break
                _, _, etype, code, value = struct.unpack('llHHi', data)
                if etype != EV_KEY or value != 1:
                    continue
                if code == KEY_ESC:
                    running = False
                elif code in (KEY_LEFT, KEY_RIGHT):
                    vx = -vx
                elif code in (KEY_UP, KEY_DOWN):
                    vy = -vy
                elif code == KEY_SPACE:
                    x, y = W // 2, H // 2

        x += vx
        y += vy
        if x - R < 0 or x + R >= W:
            vx = -vx
            x += vx
        if y - R < 0 or y + R >= H:
            vy = -vy
            y += vy

        blank(prev[0], prev[1], prev[2], prev[3])
        disc(x, y)
        prev = (x - R, y - R, 2 * R, 2 * R)
        time.sleep(1 / 60)

    m[:] = bg * (W * H)
    m.close()
    fb.close()
    if kbd >= 0:
        os.close(kbd)


if __name__ == '__main__':
    main()
