# pi-box framebuffer games

Small games render directly to the VM's virtual framebuffer (`/dev/fb0`,
1024×768, `a8r8g8b8`) and read keyboard/mouse from virtio-input. The **Screen**
tab in pi-box shows the framebuffer and forwards your keyboard/mouse to the
guest, so a game running in the VM is playable in the app.

Run one from the Screen tab's command field (or from the terminal):

```
python3 /workspace/.pi-box/fbgames/snake.py
python3 /workspace/.pi-box/fbgames/pong.py
python3 /workspace/.pi-box/fbgames/bounce.py
```

Press **Esc** in the game to quit (the Screen tab's **Stop** also works).

## The `fbgame` helper

`fbgame.py` is a tiny, stdlib-only helper (kept up to date by pi-box). A whole
game is a few dozen lines:

```python
from fbgame import Screen, Input, run, BLACK, WHITE, GREEN

def update(dt, keys, screen):
    if keys.key_down('left'):
        ...

def draw(screen, keys):
    screen.fill_rect(10, 10, 100, 20, GREEN)

run(update, draw)          # fixed-step loop; Esc quits
```

### Screen

- `fill_rect(x, y, w, h, color)`, `rect(x, y, w, h, color, thickness=1)`
- `hline(x, y, w, c)`, `vline(x, y, h, c)`, `pixel(x, y, c)`
- `disc(cx, cy, r, c)`, `circle(cx, cy, r, c)`
- `text(x, y, s, c, scale=1)`, `text_center(y, s, c, scale=1)`,
  `text_width(s, scale=1)`
- `clear(color)`, `width`, `height`
- Input: `keys.poll()`, then `keys.key_down('left')`, `keys.key_pressed('space')`;
  `keys.mouse` → `(x, y)`, `keys.buttons` (1 = left).
- Colours: `BLACK WHITE GREY DARK RED GREEN BLUE YELLOW CYAN MAGENTA ORANGE`,
  or `rgb(r, g, b)`.

Key names: `esc enter space left right up down` and `a`–`z`.

## Tips

- **Repaint only what moves.** Erase the old sprite's rectangle, then draw the
  new one. The host receives only damaged rectangles, and an idle screen sends
  nothing — so a mostly-static frame costs almost nothing.
- Keep the frame rate modest (20–60 fps). The VM is a single emulated CPU.
- This is a raw framebuffer, not a graphics stack: there is no X/Wayland/SDL.
  Drawing is direct memory writes; text uses the built-in 5×7 font.

Games in this directory are seeded once and are yours to edit — pi can write new
ones here too.
