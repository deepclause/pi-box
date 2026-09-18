"""Tiny framebuffer game library for the AgentVM virtual framebuffer.

Pure stdlib. Writes directly to /dev/fb0 (`a8r8g8b8`, bytes are B,G,R,A) and
reads keyboard/mouse from /dev/input/event0/event1. No display server needed.

    from fbgame import Screen, Input, run, BLACK, WHITE

    def update(dt, keys, screen):
        if keys.key_down('left'): ...

    def draw(screen, keys):
        screen.fill_rect(...)

    run(update, draw)

Drawing is immediate; TinyEMU tracks damaged regions, so only what you touch is
sent to the host. Keep redraws small (dirty rectangles) for smooth animation.
"""
import mmap
import os
import select
import struct
import time

WIDTH, HEIGHT = 1024, 768

EV_SYN, EV_KEY, EV_ABS = 0x00, 0x01, 0x03

# Linux evdev key codes (subset used by the examples and the host's sendKey()).
KEY_ESC = 1
KEY_ENTER = 28
KEY_SPACE = 57
KEY_LEFT, KEY_RIGHT, KEY_UP, KEY_DOWN = 105, 106, 103, 108
KEY_A, KEY_D, KEY_W, KEY_S = 30, 32, 17, 31
KEY_Q, KEY_P, KEY_R = 16, 25, 19
KEY_NAMES = {
    KEY_ESC: 'esc', KEY_ENTER: 'enter', KEY_SPACE: 'space',
    KEY_LEFT: 'left', KEY_RIGHT: 'right', KEY_UP: 'up', KEY_DOWN: 'down',
    KEY_A: 'a', KEY_D: 'd', KEY_W: 'w', KEY_S: 's', KEY_Q: 'q', KEY_P: 'p', KEY_R: 'r',
}

# evdev key values
_KEY_RELEASE, _KEY_PRESS, _KEY_REPEAT = 0, 1, 2
_BTN_LEFT = 272

ABS_X, ABS_Y = 0x00, 0x01


def rgb(r, g, b, a=255):
    """Pack a colour the way /dev/fb0 stores it (a8r8g8b8 little-endian)."""
    return bytes((b, g, r, a))


BLACK = rgb(0, 0, 0)
WHITE = rgb(255, 255, 255)
GREY = rgb(120, 120, 128)
DARK = rgb(18, 18, 22)
RED = rgb(235, 80, 90)
GREEN = rgb(90, 200, 120)
BLUE = rgb(90, 160, 255)
YELLOW = rgb(235, 200, 90)
CYAN = rgb(90, 200, 235)
MAGENTA = rgb(200, 110, 220)
ORANGE = rgb(235, 150, 70)

# 5x7 uppercase + digits + a few symbols.
FONT = {
    ' ': ('.....', '.....', '.....', '.....', '.....', '.....', '.....'),
    '0': ('.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'),
    '1': ('..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'),
    '2': ('.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'),
    '3': ('#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'),
    '4': ('...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'),
    '5': ('#####', '#....', '####.', '....#', '....#', '#...#', '.###.'),
    '6': ('..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'),
    '7': ('#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'),
    '8': ('.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'),
    '9': ('.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'),
    'A': ('.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'),
    'B': ('####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'),
    'C': ('.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'),
    'D': ('###..', '#..#.', '#...#', '#...#', '#...#', '#..#.', '###..'),
    'E': ('#####', '#....', '#....', '####.', '#....', '#....', '#####'),
    'F': ('#####', '#....', '#....', '####.', '#....', '#....', '#....'),
    'G': ('.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'),
    'H': ('#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'),
    'I': ('.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'),
    'J': ('..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'),
    'K': ('#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'),
    'L': ('#....', '#....', '#....', '#....', '#....', '#....', '#####'),
    'M': ('#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'),
    'N': ('#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'),
    'O': ('.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'),
    'P': ('####.', '#...#', '#...#', '####.', '#....', '#....', '#....'),
    'Q': ('.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'),
    'R': ('####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'),
    'S': ('.####', '#....', '#....', '.###.', '....#', '....#', '####.'),
    'T': ('#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'),
    'U': ('#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'),
    'V': ('#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'),
    'W': ('#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'),
    'X': ('#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'),
    'Y': ('#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'),
    'Z': ('#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'),
    ':': ('.....', '..#..', '..#..', '.....', '..#..', '..#..', '.....'),
    '-': ('.....', '.....', '.....', '#####', '.....', '.....', '.....'),
    '.': ('.....', '.....', '.....', '.....', '.....', '.##..', '.##..'),
    '!': ('..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'),
    '?': ('.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'),
    '/': ('....#', '...#.', '...#.', '..#..', '.#...', '.#...', '#....'),
}
GLYPH_W, GLYPH_H, GLYPH_GAP = 5, 7, 1


class Screen:
    """A writable /dev/fb0 surface with a few drawing primitives."""

    def __init__(self, width=WIDTH, height=HEIGHT):
        self.width = width
        self.height = height
        self._file = open('/dev/fb0', 'r+b', buffering=0)
        self._fb = mmap.mmap(self._file.fileno(), width * height * 4)
        self._bg = BLACK

    def close(self):
        self._fb.close()
        self._file.close()

    # -- primitives ---------------------------------------------------------
    def clear(self, color=BLACK):
        self._bg = color
        self._fb[:] = color * (self.width * self.height)

    def fill_rect(self, x, y, w, h, color):
        """A filled rectangle, clamped to the screen."""
        x0, y0 = max(0, int(x)), max(0, int(y))
        x1, y1 = min(self.width, int(x) + int(w)), min(self.height, int(y) + int(h))
        if x1 <= x0 or y1 <= y0:
            return
        row = color * (x1 - x0)
        for j in range(y0, y1):
            o = (j * self.width + x0) * 4
            self._fb[o:o + (x1 - x0) * 4] = row

    def rect(self, x, y, w, h, color, thickness=1):
        self.fill_rect(x, y, w, thickness, color)
        self.fill_rect(x, y + h - thickness, w, thickness, color)
        self.fill_rect(x, y, thickness, h, color)
        self.fill_rect(x + w - thickness, y, thickness, h, color)

    def pixel(self, x, y, color):
        if 0 <= x < self.width and 0 <= y < self.height:
            o = (int(y) * self.width + int(x)) * 4
            self._fb[o:o + 4] = color

    def hline(self, x, y, w, color):
        self.fill_rect(x, y, w, 1, color)

    def vline(self, x, y, h, color):
        self.fill_rect(x, y, 1, h, color)

    def disc(self, cx, cy, r, color):
        cx, cy, r = int(cx), int(cy), int(r)
        for dy in range(-r, r + 1):
            span = int((r * r - dy * dy) ** 0.5)
            self.fill_rect(cx - span, cy + dy, 2 * span + 1, 1, color)

    def circle(self, cx, cy, r, color):
        for dy in range(-r, r + 1):
            span = int((r * r - dy * dy) ** 0.5)
            self.fill_rect(cx - span, cy + dy, 1, 1, color)
            self.fill_rect(cx + span, cy + dy, 1, 1, color)

    def text(self, x, y, string, color, scale=1):
        """Draw text (uppercase; unknown characters are skipped)."""
        cx = x
        for ch in str(string).upper():
            glyph = FONT.get(ch)
            if glyph:
                for ry, row in enumerate(glyph):
                    for rx, cell in enumerate(row):
                        if cell == '#':
                            self.fill_rect(cx + rx * scale, y + ry * scale, scale, scale, color)
            cx += (GLYPH_W + GLYPH_GAP) * scale
        return cx

    def text_width(self, string, scale=1):
        return len(str(string)) * (GLYPH_W + GLYPH_GAP) * scale

    def text_center(self, y, string, color, scale=1):
        self.text((self.width - self.text_width(string, scale)) // 2, y, string, color, scale)


class Input:
    """Keyboard + mouse from virtio-input (/dev/input/event0/event1)."""

    def __init__(self):
        self._kbd = self._open('/dev/input/event0')
        self._mouse = self._open('/dev/input/event1')
        self.keys = set()
        self.pressed = []
        self.released = []
        self.mouse = (0, 0)
        self.buttons = 0

    @staticmethod
    def _open(path):
        try:
            return os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        except OSError:
            return -1

    def close(self):
        for fd in (self._kbd, self._mouse):
            if fd >= 0:
                os.close(fd)

    def _drain(self, fd):
        events = []
        if fd < 0:
            return events
        while select.select([fd], [], [], 0)[0]:
            data = os.read(fd, 24)
            if len(data) < 24:
                break
            events.append(struct.unpack('llHHi', data))
        return events

    def poll(self):
        """Read pending input; updates `keys`/`pressed`/`released`/`mouse`."""
        self.pressed = []
        self.released = []
        for _sec, _usec, etype, code, value in self._drain(self._kbd):
            if etype != EV_KEY:
                continue
            name = KEY_NAMES.get(code)
            if name is None:
                continue
            if value == _KEY_PRESS:
                if name not in self.keys:
                    self.pressed.append(name)
                self.keys.add(name)
            elif value == _KEY_RELEASE:
                self.keys.discard(name)
                self.released.append(name)
        x = y = None
        for _sec, _usec, etype, code, value in self._drain(self._mouse):
            if etype == EV_ABS and code == ABS_X:
                x = value
            elif etype == EV_ABS and code == ABS_Y:
                y = value
            elif etype == EV_KEY and code == _BTN_LEFT:
                if value:
                    self.buttons |= 1
                else:
                    self.buttons &= ~1
        if x is not None or y is not None:
            self.mouse = (self.mouse[0] if x is None else x, self.mouse[1] if y is None else y)
        return self

    def key_down(self, name):
        return name in self.keys

    def key_pressed(self, name):
        return name in self.pressed


def run(update, draw, fps=30, screen=None, keys=None):
    """Fixed-step loop. `update(dt, keys, screen)` then `draw(screen, keys)`.

    Stops when Esc is pressed. Returns when the game ends; call `screen.close()`
    and `keys.close()` afterwards (or use a `with`-style try/finally).
    """
    screen = Screen() if screen is None else screen
    keys = Input() if keys is None else keys
    dt = 1.0 / fps
    last = time.time()
    try:
        while True:
            keys.poll()
            if keys.key_pressed('esc'):
                break
            update(dt, keys, screen)
            draw(screen, keys)
            now = time.time()
            sleep = dt - (now - last)
            if sleep > 0:
                time.sleep(sleep)
            last = time.time()
    finally:
        keys.close()
        screen.close()
