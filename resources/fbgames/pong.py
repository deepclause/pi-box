#!/usr/bin/env python3
"""Pong for the AgentVM framebuffer, built on the `fbgame` helper.

W/S (or Up/Down) move the left paddle; the right paddle is a simple AI. First to
7 wins; Space/Enter restarts, Esc quits. Only the paddles and ball are repainted.
"""
import random
import time

from fbgame import (
    Screen, Input, BLACK, DARK, GREY, WHITE, YELLOW, GREEN, RED
)

W, H = 1024, 768
PADDLE_W, PADDLE_H, MARGIN = 16, 110, 40
BALL_R = 9
WIN_SCORE = 7


def reset_ball(direction):
    return [W // 2, H // 2 + random.randint(-120, 120)], [direction * 9, random.choice([-5, 5])]


def draw_center(screen):
    screen.fill_rect(W // 2 - 2, 0, 4, H, DARK)


def draw_hud(screen, left, right):
    screen.fill_rect(120, 24, 320, 40, BLACK)
    screen.fill_rect(600, 24, 320, 40, BLACK)
    screen.text(360, 20, str(left), WHITE, 5)
    screen.text(640, 20, str(right), WHITE, 5)


def match_over(screen, keys, left, right):
    screen.fill_rect(212, 296, 600, 176, DARK)
    screen.rect(212, 296, 600, 176, GREEN, 3)
    screen.text_center(326, 'PLAYER WINS' if left > right else 'CPU WINS', GREEN, 4)
    screen.text_center(394, '{} - {}'.format(left, right), WHITE, 3)
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
    draw_center(screen)
    left_y = (H - PADDLE_H) // 2
    right_y = (H - PADDLE_H) // 2
    screen.fill_rect(MARGIN, left_y, PADDLE_W, PADDLE_H, GREEN)
    screen.fill_rect(W - MARGIN - PADDLE_W, right_y, PADDLE_W, PADDLE_H, RED)

    (ball_x, ball_y), (vx, vy) = reset_ball(random.choice([-1, 1]))
    prev_ball = (ball_x, ball_y)
    score_left = score_right = 0
    draw_hud(screen, score_left, score_right)

    last = time.time()
    while True:
        keys.poll()
        if keys.key_pressed('esc'):
            return False

        dt = min(time.time() - last, 0.05)
        last = time.time()

        # Left paddle
        speed = 620
        move = (1 if (keys.key_down('down') or keys.key_down('s')) else 0) - (
            1 if (keys.key_down('up') or keys.key_down('w')) else 0
        )
        new_left = min(max(0, left_y + move * speed * dt), H - PADDLE_H)
        if new_left != left_y:
            screen.fill_rect(MARGIN, left_y, PADDLE_W, PADDLE_H, BLACK)
            left_y = new_left
            screen.fill_rect(MARGIN, left_y, PADDLE_W, PADDLE_H, GREEN)

        # Right paddle follows the ball, capped speed
        target = ball_y - PADDLE_H // 2
        ai = min(max(-460 * dt, target - right_y), 460 * dt)
        if abs(ai) > 1:
            screen.fill_rect(W - MARGIN - PADDLE_W, right_y, PADDLE_W, PADDLE_H, BLACK)
            right_y = min(max(0, right_y + ai), H - PADDLE_H)
            screen.fill_rect(W - MARGIN - PADDLE_W, right_y, PADDLE_W, PADDLE_H, RED)

        # Ball
        ball_x += vx * dt
        ball_y += vy * dt
        if ball_y - BALL_R < 0 or ball_y + BALL_R > H:
            vy = -vy
            ball_y = max(BALL_R, min(H - BALL_R, ball_y))

        left_face = MARGIN + PADDLE_W
        right_face = W - MARGIN - PADDLE_W
        if vx < 0 and ball_x - BALL_R <= left_face and left_y <= ball_y <= left_y + PADDLE_H:
            vx = -vx
            ball_x = left_face + BALL_R
        elif vx > 0 and ball_x + BALL_R >= right_face and right_y <= ball_y <= right_y + PADDLE_H:
            vx = -vx
            ball_x = right_face - BALL_R

        scored = None
        if ball_x < -BALL_R:
            scored = 'right'
        elif ball_x > W + BALL_R:
            scored = 'left'

        # Repaint: erase the old ball, draw the new one.
        screen.fill_rect(prev_ball[0] - BALL_R, prev_ball[1] - BALL_R, BALL_R * 2, BALL_R * 2, BLACK)
        if scored:
            draw_center(screen)
        else:
            screen.disc(ball_x, ball_y, BALL_R, YELLOW)
        prev_ball = (ball_x, ball_y)

        if scored:
            if scored == 'left':
                score_left += 1
            else:
                score_right += 1
            draw_hud(screen, score_left, score_right)
            if score_left >= WIN_SCORE or score_right >= WIN_SCORE:
                return match_over(screen, keys, score_left, score_right)
            (ball_x, ball_y), (vx, vy) = reset_ball(-1 if scored == 'right' else 1)
            prev_ball = (ball_x, ball_y)
            screen.fill_rect(W // 2 - 2, 0, 4, H, DARK)
            screen.disc(ball_x, ball_y, BALL_R, YELLOW)

        time.sleep(0.002)


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
