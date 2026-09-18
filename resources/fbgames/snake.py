#!/usr/bin/env python3
"""Snake for the AgentVM framebuffer, built on the `fbgame` helper.

Arrows (or WASD) steer, Space/Enter restarts, Esc quits. Only changed cells are
repainted, so the host receives small damage rects.
"""
import random
import time

from fbgame import Screen, Input, BLACK, DARK, GREEN, RED, WHITE, GREY, YELLOW

CELL = 32
TOP = 64
COLS = 1024 // CELL
ROWS = (768 - TOP) // CELL
FPS = 8


def cell_rect(cx, cy):
    return cx * CELL, TOP + cy * CELL, CELL - 2, CELL - 2


def spawn_food(snake):
    while True:
        cell = (random.randrange(COLS), random.randrange(ROWS))
        if cell not in snake:
            return cell


def draw_hud(screen, score):
    screen.fill_rect(0, 0, 1024, TOP, DARK)
    screen.text(16, 18, 'SNAKE', GREEN, 3)
    screen.text(660, 20, 'SCORE ' + str(score).rjust(3, '0'), YELLOW, 3)
    screen.hline(0, TOP - 2, 1024, GREY)


def game_over(screen, keys, score):
    screen.fill_rect(212, 296, 600, 176, DARK)
    screen.rect(212, 296, 600, 176, RED, 3)
    screen.text_center(326, 'GAME OVER', RED, 4)
    screen.text_center(394, 'SCORE ' + str(score), WHITE, 3)
    screen.text_center(436, 'SPACE TO PLAY AGAIN', GREY, 2)
    while True:
        keys.poll()
        if keys.key_pressed('esc'):
            return False
        if keys.key_pressed('space') or keys.key_pressed('enter'):
            return True
        time.sleep(0.03)


def play(screen, keys):
    screen.clear(BLACK)
    draw_hud(screen, 0)
    snake = [(COLS // 2, ROWS // 2)]
    direction = (1, 0)
    food = spawn_food(snake)
    score = 0
    screen.fill_rect(*cell_rect(*snake[0]), GREEN)
    screen.fill_rect(*cell_rect(*food), RED)

    interval = 1.0 / FPS
    acc = interval
    last = time.time()
    while True:
        keys.poll()
        if keys.key_pressed('esc'):
            return False
        if keys.key_pressed('up') and direction != (0, 1):
            direction = (0, -1)
        elif keys.key_pressed('down') and direction != (0, -1):
            direction = (0, 1)
        elif keys.key_pressed('left') and direction != (1, 0):
            direction = (-1, 0)
        elif keys.key_pressed('right') and direction != (-1, 0):
            direction = (1, 0)

        now = time.time()
        acc += now - last
        last = now
        if acc >= interval:
            acc -= interval
            head = (snake[0][0] + direction[0], snake[0][1] + direction[1])
            if not (0 <= head[0] < COLS and 0 <= head[1] < ROWS) or head in snake:
                return game_over(screen, keys, score)
            snake.insert(0, head)
            screen.fill_rect(*cell_rect(*head), GREEN)
            if head == food:
                score += 1
                draw_hud(screen, score)
                screen.fill_rect(*cell_rect(*head), GREEN)
                food = spawn_food(snake)
                screen.fill_rect(*cell_rect(*food), RED)
            else:
                tail = snake.pop()
                screen.fill_rect(*cell_rect(*tail), BLACK)
        time.sleep(0.005)


def main():
    screen = Screen()
    keys = Input()
    try:
        while play(screen, keys):
            pass
    finally:
        keys.close()
        screen.close()


if __name__ == '__main__':
    main()
