// DOM/CSS overlay (placeholder look, final API): menu, HUD, pause, game over, toast.
// The UI never talks to the game directly: it calls the handlers it was given.
import type { Quality, SimState } from '../sim/types';
import './ui.css';

export interface UIHandlers {
  onPlay(): void;
  onPause(): void;
  onResume(): void;
  onRestart(): void;
  onHome(): void;
  onMute(muted: boolean): void;
  onQuality(q: Quality): void;
}

export interface GameOverInfo {
  score: number;
  coins: number;
  best: number;
  newBest: boolean;
  reason: string;
}

export interface UIOptions {
  muted?: boolean;
  quality?: Quality;
}

type Screen = 'menu' | 'hud' | 'pause' | 'gameover';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class UI {
  private readonly root: HTMLElement;
  private readonly h: UIHandlers;
  private readonly screens: Record<Screen, HTMLElement>;
  private readonly scoreEl: HTMLElement;
  private readonly coinsEl: HTMLElement;
  private readonly bestEl: HTMLElement;
  private readonly overScore: HTMLElement;
  private readonly overCoins: HTMLElement;
  private readonly overBest: HTMLElement;
  private readonly overTitle: HTMLElement;
  private readonly toastEl: HTMLElement;
  private readonly muteBtn: HTMLButtonElement;
  private readonly qualitySel: HTMLSelectElement;
  private muted: boolean;
  private lastScore = -1;
  private lastCoins = -1;
  private toastTimer = 0;

  constructor(root: HTMLElement, handlers: UIHandlers, options: UIOptions = {}) {
    this.root = root;
    this.h = handlers;
    this.muted = options.muted ?? false;
    root.classList.add('wr-ui');

    const btn = (label: string, cls: string, fn: () => void) => {
      const b = el('button', `wr-btn ${cls}`, label);
      b.type = 'button';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    };

    // Menu
    const menu = el('div', 'wr-screen wr-menu');
    const title = el('h1', 'wr-title');
    title.append(el('span', 'wr-title-a', 'WAYMAN'), el('span', 'wr-title-b', 'RUN'));
    this.bestEl = el('div', 'wr-best');
    const row = el('div', 'wr-row');
    this.muteBtn = btn('', 'wr-small', () => this.setMuted(!this.muted));
    this.qualitySel = el('select', 'wr-select');
    for (const q of ['low', 'medium', 'high'] as const) {
      const o = el('option', '', q[0].toUpperCase() + q.slice(1));
      o.value = q;
      this.qualitySel.append(o);
    }
    this.qualitySel.value = options.quality ?? 'high';
    this.qualitySel.addEventListener('change', () => this.h.onQuality(this.qualitySel.value as Quality));
    row.append(this.muteBtn, this.qualitySel);
    menu.append(title, el('div', 'wr-tag', 'Deliver fast. Do not get caught.'), btn('Play', 'wr-primary', () => this.h.onPlay()), this.bestEl, row,
      el('div', 'wr-help', 'Arrows / WASD / swipe to move  ·  Space = jump  ·  P = pause'));

    // HUD
    const hud = el('div', 'wr-screen wr-hud');
    const stats = el('div', 'wr-stats');
    this.scoreEl = el('div', 'wr-score', '0');
    this.coinsEl = el('div', 'wr-coins', '0');
    stats.append(this.scoreEl, this.coinsEl);
    hud.append(stats, btn('II', 'wr-pause-btn', () => this.h.onPause()));

    // Pause
    const pause = el('div', 'wr-screen wr-panel-screen');
    const pp = el('div', 'wr-panel');
    pp.append(el('h2', 'wr-h2', 'Paused'), btn('Resume', 'wr-primary', () => this.h.onResume()), btn('Home', '', () => this.h.onHome()));
    pause.append(pp);

    // Game over
    const over = el('div', 'wr-screen wr-panel-screen');
    const op = el('div', 'wr-panel');
    this.overTitle = el('h2', 'wr-h2', 'Caught!');
    this.overScore = el('div', 'wr-big');
    this.overCoins = el('div', 'wr-line');
    this.overBest = el('div', 'wr-line');
    op.append(this.overTitle, this.overScore, this.overCoins, this.overBest, btn('Play again', 'wr-primary', () => this.h.onRestart()), btn('Home', '', () => this.h.onHome()));
    over.append(op);

    this.toastEl = el('div', 'wr-toast');
    this.screens = { menu, hud, pause, gameover: over };
    root.append(menu, hud, pause, over, this.toastEl);
    this.renderMute();
    this.show(null);
  }

  showMenu(best: { score: number; coins: number }): void {
    this.bestEl.textContent = best.score > 0 ? `Best ${best.score.toLocaleString()}  ·  ${best.coins} coins` : '';
    this.show('menu');
  }

  showHud(): void {
    this.lastScore = this.lastCoins = -1;
    this.show('hud');
  }

  showPause(): void {
    this.show('pause');
  }

  showGameOver(r: GameOverInfo): void {
    this.overTitle.textContent = r.reason === 'caught' ? 'Caught!' : 'Crash!';
    this.overScore.textContent = r.score.toLocaleString();
    this.overCoins.textContent = `${r.coins} coins`;
    this.overBest.textContent = r.newBest ? 'New best!' : `Best ${r.best.toLocaleString()}`;
    this.show('gameover');
  }

  /** Cheap to call every frame: only touches the DOM when values change. */
  updateHud(s: SimState): void {
    if (s.score !== this.lastScore) {
      this.lastScore = s.score;
      this.scoreEl.textContent = String(s.score);
    }
    if (s.coins !== this.lastCoins) {
      this.lastCoins = s.coins;
      this.coinsEl.textContent = String(s.coins);
    }
  }

  toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('wr-show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('wr-show'), 1600);
  }

  private setMuted(m: boolean): void {
    this.muted = m;
    this.renderMute();
    this.h.onMute(m);
  }

  private renderMute(): void {
    this.muteBtn.textContent = this.muted ? 'Sound: off' : 'Sound: on';
  }

  private show(screen: Screen | null): void {
    for (const [k, e] of Object.entries(this.screens)) e.classList.toggle('wr-visible', k === screen);
    this.root.dataset.screen = screen ?? '';
  }
}
