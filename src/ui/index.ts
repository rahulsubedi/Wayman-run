// DOM/CSS overlay: title menu, HUD, pause (with 3-2-1 resume), game over, toasts and popups.
// The UI never talks to the game directly: it calls the handlers it was given.
import { POWERUP_DURATION } from '../sim/config';
import type { Quality, SimState } from '../sim/types';
import { ICONS, type IconName } from './icons';
import { loadSettings, saveSettings } from './settings';
import './ui.css';

export { loadSettings, saveSettings } from './settings';
export type { Settings } from './settings';

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
  /** Fun per-run facts shown under the score, e.g. { label: 'Near misses', value: '7' }. */
  extras?: readonly { label: string; value: string }[];
}

export interface UIOptions {
  muted?: boolean;
  quality?: Quality;
  /** Run a 3-2-1 countdown after pressing Resume before calling onResume (default true). */
  resumeCountdown?: boolean;
  /** Called for every UI button press (wire to audio.sfx('click')). */
  onClick?: () => void;
}

export type PopupKind = 'good' | 'great' | 'info' | 'danger';

type Screen = 'menu' | 'hud' | 'pause' | 'gameover' | 'countdown';

const QUALITIES: readonly Quality[] = ['low', 'medium', 'high'];
const QUALITY_LABEL: Record<Quality, string> = { low: 'Low', medium: 'Med', high: 'High' };
const CHIP_STEPS = 40;
/** Popup rules: two fixed slots (no overlap), low priority dropped when busy, high ones queued briefly. */
const POPUP_SLOTS = 2;
const POPUP_MS = 950;
const POPUP_QUEUE_MAX = 2;
const POPUP_QUEUE_TTL = 1300;
const CONFETTI = 36;
const GAMEOVER_INPUT_LOCK_MS = 650;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** 0 distance marks, 1 near miss, 3 power-up labels / shield save, 4 stumble. */
function popupPriority(text: string, kind: PopupKind): number {
  if (kind === 'danger') return 4;
  if (kind === 'info') return 0;
  if (kind === 'great' && /near miss/i.test(text)) return 1;
  return 3;
}

function icon(name: IconName): HTMLSpanElement {
  const s = el('span', 'wr-ico-wrap');
  s.innerHTML = ICONS[name];
  return s;
}

/** 12345 -> "12,345" (only runs when the value changes). */
function fmt(n: number): string {
  const s = String(Math.max(0, Math.floor(n)));
  if (s.length <= 3) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return out;
}

interface Chip {
  root: HTMLElement;
  bar: HTMLElement | null;
  q: number;
  low: boolean;
}

export class UI {
  private readonly root: HTMLElement;
  private readonly h: UIHandlers;
  private readonly opts: UIOptions;
  private readonly screens: Record<Screen, HTMLElement>;

  private readonly scoreText: Text;
  private readonly coinText: Text;
  private readonly coinPill: HTMLElement;
  private readonly multEl: HTMLElement;
  private readonly multText: Text;
  private readonly chips: Chip[] = [];

  private readonly bestScoreText: Text;
  private readonly bestCoinsText: Text;
  private readonly bestRow: HTMLElement;

  private readonly overTitle: HTMLElement;
  private readonly overSub: HTMLElement;
  private readonly overScoreText: Text;
  private readonly overCoinsText: Text;
  private readonly overBestText: Text;
  private readonly overPanel: HTMLElement;
  private readonly overBadge: HTMLElement;
  private readonly confettiEl: HTMLElement;
  private readonly overExtras: HTMLElement;
  private readonly dangerEl: HTMLElement;
  private readonly dangerBar: HTMLElement;
  private lastDanger = -1;
  private readonly countNum: HTMLElement;

  private readonly toastEl: HTMLElement;
  private readonly toastText: Text;
  private readonly popups: HTMLElement[] = [];
  private readonly popupUntil: number[] = [];
  private readonly popupPrio: number[] = [];
  private readonly popupText: string[] = [];
  private popupQueue: { text: string; kind: PopupKind; prio: number; at: number }[] = [];
  private popupPump = 0;

  private readonly muteBtns: HTMLButtonElement[] = [];
  private readonly qualityBtns: HTMLButtonElement[] = [];

  private muted: boolean;
  private quality: Quality;
  private current: Screen | null = null;

  private lastScore = -1;
  private lastCoins = -1;
  private lastMult = -1;
  private bumpFlip = false;
  private toastFlip = false;

  private countTimer = 0;
  private counting = false;
  private overShownAt = 0;
  private countRaf = 0;
  private readonly reduceMotion: boolean;

  constructor(root: HTMLElement, handlers: UIHandlers, options: UIOptions = {}) {
    this.root = root;
    this.h = handlers;
    this.opts = options;
    const stored = loadSettings();
    // Stored mute is applied (and reported to the game) below; an explicit mute option wins.
    this.muted = options.muted === true || stored.muted;
    this.quality = options.quality ?? stored.quality ?? 'high';
    this.reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    root.classList.add('wr-ui');

    const button = (children: (string | Node)[], cls: string, fn: () => void, label?: string): HTMLButtonElement => {
      const b = el('button', `wr-btn ${cls}`);
      b.type = 'button';
      if (label) b.setAttribute('aria-label', label);
      b.append(...children);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.detail > 0) b.blur(); // keep Space/Enter free for the game after a mouse/touch click
        this.opts.onClick?.();
        fn();
      });
      return b;
    };
    const label = (t: string) => el('span', 'wr-btn-label', t);

    // ------------------------------------------------------------------ menu
    const menu = el('div', 'wr-screen wr-menu');
    const logo = el('h1', 'wr-logo');
    logo.setAttribute('aria-label', 'Wayman Run');
    const word = (text: string, cls: string): HTMLElement => {
      const w = el('span', cls);
      w.setAttribute('aria-hidden', 'true');
      w.append(el('span', 'wr-lg-edge', text), el('span', 'wr-lg-body', text), el('span', 'wr-lg-front', text));
      return w;
    };
    const lw = word('WAYMAN', 'wr-logo-w');
    const lrText = word('RUN', 'wr-logo-rt');
    const lr = el('span', 'wr-logo-r');
    lr.setAttribute('aria-hidden', 'true');
    const streaks = el('span', 'wr-logo-streaks');
    streaks.innerHTML = '<i></i><i></i><i></i>';
    lr.append(streaks, lrText, icon('parcel'));
    logo.append(lw, lr);
    const tag = el('p', 'wr-tag', 'Deliver fast. Do not get caught.');

    const playBtn = button([icon('play'), label('PLAY')], 'wr-primary wr-play', () => this.h.onPlay());
    this.bestScoreText = document.createTextNode('0');
    this.bestCoinsText = document.createTextNode('0');
    this.bestRow = el('div', 'wr-stats-row');
    const bs = el('div', 'wr-stat');
    bs.append(icon('star'), el('span', 'wr-stat-k', 'BEST'));
    const bsv = el('span', 'wr-stat-v');
    bsv.append(this.bestScoreText);
    bs.append(bsv);
    const bc = el('div', 'wr-stat');
    bc.append(icon('coin'), el('span', 'wr-stat-k', 'COINS'));
    const bcv = el('span', 'wr-stat-v');
    bcv.append(this.bestCoinsText);
    bc.append(bcv);
    this.bestRow.append(bs, bc);

    const settings = el('div', 'wr-settings');
    const muteBtn = this.makeMuteButton(button);
    const seg = el('div', 'wr-seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Graphics quality');
    for (const q of QUALITIES) {
      const b = el('button', 'wr-seg-btn', QUALITY_LABEL[q]);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.detail > 0) b.blur();
        this.opts.onClick?.();
        this.setQuality(q, true);
      });
      this.qualityBtns.push(b);
      seg.append(b);
    }
    const segWrap = el('div', 'wr-seg-wrap');
    segWrap.append(el('span', 'wr-seg-label', 'GRAPHICS'), seg);
    settings.append(muteBtn, segWrap);

    const howto = el('div', 'wr-howto');
    howto.append(this.buildHowto());

    const mTop = el('div', 'wr-menu-brand');
    mTop.append(logo, tag);
    const mMid = el('div', 'wr-menu-main');
    mMid.append(playBtn, this.bestRow, settings);
    menu.append(mTop, mMid, howto);

    // ------------------------------------------------------------------- HUD
    const hud = el('div', 'wr-screen wr-hud');
    const top = el('div', 'wr-hud-top');
    this.coinPill = el('div', 'wr-pill wr-coinpill');
    const coinNum = el('span', 'wr-coin-num');
    this.coinText = document.createTextNode('0');
    coinNum.append(this.coinText);
    this.coinPill.append(icon('coin'), coinNum);

    const scoreBox = el('div', 'wr-scorebox');
    const scoreNum = el('div', 'wr-score-num');
    this.scoreText = document.createTextNode('0');
    scoreNum.append(this.scoreText);
    this.multEl = el('div', 'wr-mult');
    this.multText = document.createTextNode('x2');
    this.multEl.append(this.multText);
    scoreBox.append(el('div', 'wr-score-k', 'SCORE'), scoreNum, this.multEl);

    const pauseBtn = button([icon('pause')], 'wr-round wr-pausebtn', () => this.h.onPause(), 'Pause');
    const topL = el('div', 'wr-hud-l');
    topL.append(this.coinPill);
    const topR = el('div', 'wr-hud-r');
    topR.append(pauseBtn);
    top.append(topL, scoreBox, topR);

    const chipRow = el('div', 'wr-chips');
    this.chips.push(this.makeChip(chipRow, 'magnet', 'wr-chip-magnet', true));
    this.chips.push(this.makeChip(chipRow, 'rocket', 'wr-chip-boost', true));
    this.chips.push(this.makeChip(chipRow, 'x2', 'wr-chip-mult', true));
    this.chips.push(this.makeChip(chipRow, 'shield', 'wr-chip-shield', false));
    this.dangerEl = el('div', 'wr-danger');
    this.dangerBar = el('i', '');
    const dBar = el('span', 'wr-danger-bar');
    dBar.append(this.dangerBar);
    this.dangerEl.append(el('span', 'wr-danger-k', 'WATCH OUT'), dBar);
    hud.append(top, this.dangerEl, chipRow);

    // ----------------------------------------------------------------- pause
    const pause = el('div', 'wr-screen wr-dim');
    const pp = el('div', 'wr-panel wr-pause-panel');
    const ptitle = el('h2', 'wr-h2', 'PAUSED');
    const prow = el('div', 'wr-btn-row');
    prow.append(
      button([icon('restart'), label('Restart')], 'wr-secondary', () => this.h.onRestart()),
      button([icon('home'), label('Home')], 'wr-secondary', () => this.h.onHome()),
    );
    pp.append(
      ptitle,
      button([icon('play'), label('RESUME')], 'wr-primary', () => this.resumeWithCountdown()),
      prow,
      this.makeMuteButton(button, true),
    );
    pause.append(pp);

    // -------------------------------------------------------------- countdown
    const count = el('div', 'wr-screen wr-count');
    this.countNum = el('div', 'wr-count-num', '3');
    count.append(this.countNum, el('div', 'wr-count-k', 'GET READY'));

    // ------------------------------------------------------------- game over
    const over = el('div', 'wr-screen wr-dim wr-over');
    const confetti = el('div', 'wr-confetti');
    this.confettiEl = confetti;
    confetti.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < CONFETTI; i++) {
      const c = el('i', '');
      const a = (i / CONFETTI) * Math.PI * 2 + Math.random() * 0.5;
      const dist = 0.4 + Math.random() * 0.6;
      c.style.setProperty('--fx', (Math.cos(a) * dist).toFixed(3));
      c.style.setProperty('--fy', (Math.sin(a) * dist * 0.7 - 0.2).toFixed(3));
      c.style.setProperty('--rot', `${Math.round(Math.random() * 720 - 360)}deg`);
      c.style.setProperty('--del', `${(Math.random() * 0.25).toFixed(2)}s`);
      c.style.setProperty('--c', ['#ffd23f', '#17c3b2', '#ff8a1f', '#fff3d6', '#ff5d4d'][i % 5]);
      confetti.append(c);
    }
    this.overPanel = el('div', 'wr-panel wr-over-panel');
    this.overTitle = el('h2', 'wr-h2 wr-over-title', 'CRASHED!');
    this.overSub = el('p', 'wr-over-sub', '');
    this.overBadge = el('div', 'wr-newbest');
    this.overBadge.append(icon('star'), el('span', '', 'NEW BEST!'), icon('star'));
    const scoreK = el('div', 'wr-over-k', 'SCORE');
    const scoreV = el('div', 'wr-over-score');
    this.overScoreText = document.createTextNode('0');
    scoreV.append(this.overScoreText);
    this.overExtras = el('div', 'wr-over-extras');
    const stats = el('div', 'wr-over-stats');
    const s1 = el('div', 'wr-stat wr-stat-lg');
    s1.append(icon('coin'), el('span', 'wr-stat-k', 'COINS'));
    const s1v = el('span', 'wr-stat-v');
    this.overCoinsText = document.createTextNode('0');
    s1v.append(this.overCoinsText);
    s1.append(s1v);
    const s2 = el('div', 'wr-stat wr-stat-lg');
    s2.append(icon('star'), el('span', 'wr-stat-k', 'BEST'));
    const s2v = el('span', 'wr-stat-v');
    this.overBestText = document.createTextNode('0');
    s2v.append(this.overBestText);
    s2.append(s2v);
    stats.append(s1, s2);
    const orow = el('div', 'wr-btn-row');
    orow.append(button([icon('home'), label('Home')], 'wr-secondary', () => this.h.onHome()));
    this.overPanel.append(
      this.overTitle,
      this.overSub,
      this.overBadge,
      scoreK,
      scoreV,
      stats,
      this.overExtras,
      button([icon('restart'), label('PLAY AGAIN')], 'wr-primary', () => this.h.onRestart()),
      orow,
    );
    over.append(confetti, this.overPanel);

    // ------------------------------------------------------- toast & popups
    this.toastEl = el('div', 'wr-toast');
    this.toastText = document.createTextNode('');
    const toastIn = el('span', 'wr-toast-text');
    toastIn.append(this.toastText);
    this.toastEl.append(el('i', 'wr-toast-flag'), toastIn, el('i', 'wr-toast-flag wr-r'));
    const popLayer = el('div', 'wr-popups');
    for (let i = 0; i < POPUP_SLOTS; i++) {
      const p = el('div', 'wr-popup');
      this.popups.push(p);
      this.popupUntil.push(0);
      this.popupPrio.push(0);
      this.popupText.push('');
      popLayer.append(p);
    }

    this.screens = { menu, hud, pause, gameover: over, countdown: count };
    // zone banner + popups live in the HUD flow, under the power-up chips (never over them)
    const feed = el('div', 'wr-feed');
    feed.append(this.toastEl, popLayer);
    hud.append(feed);
    root.append(menu, hud, count, pause, over);
    this.renderMute();
    this.renderQuality();
    this.show(null);
    window.addEventListener('keydown', this.onKey);

    // Remove the boot splash from index.html, if present.
    const boot = document.getElementById('wr-boot');
    if (boot) {
      boot.classList.add('wr-boot-out');
      window.setTimeout(() => boot.remove(), 500);
    }

    // The game may have been constructed unmuted while the player's saved choice is muted.
    if (this.muted && options.muted !== true) this.h.onMute(true);
  }

  // ------------------------------------------------------------- public API

  showMenu(best: { score: number; coins: number }): void {
    this.bestScoreText.data = fmt(best.score);
    this.bestCoinsText.data = fmt(best.coins);
    this.bestRow.classList.toggle('wr-hidden', best.score <= 0 && best.coins <= 0);
    this.show('menu');
  }

  showHud(): void {
    this.setDanger(0);
    this.lastScore = this.lastCoins = this.lastMult = -1;
    for (const c of this.chips) {
      c.q = -1;
      c.low = false;
      c.root.classList.remove('wr-on', 'wr-low');
    }
    this.multEl.classList.remove('wr-on');
    this.show('hud');
  }

  showPause(): void {
    this.show('pause');
  }

  showGameOver(r: GameOverInfo): void {
    const caught = r.reason === 'caught';
    this.overTitle.textContent = caught ? 'CAUGHT!' : r.reason === 'crash' ? 'CRASHED!' : 'RUN OVER';
    this.overSub.textContent = caught ? 'The Warden got you.' : r.reason === 'crash' ? 'Watch the road, courier!' : '';
    this.overPanel.classList.toggle('wr-is-best', r.newBest);
    this.overBadge.classList.toggle('wr-on', r.newBest);
    this.confettiEl.classList.toggle('wr-on', r.newBest);
    this.overCoinsText.data = fmt(r.coins);
    this.overBestText.data = fmt(r.best);
    this.overExtras.textContent = '';
    for (const x of r.extras ?? []) {
      const c = el('div', 'wr-xstat');
      c.append(el('span', 'wr-xstat-v', x.value), el('span', 'wr-xstat-k', x.label));
      this.overExtras.append(c);
    }
    this.overExtras.classList.toggle('wr-hidden', !(r.extras && r.extras.length));
    this.overShownAt = performance.now();
    this.show('gameover');
    // restart the entrance animations
    this.overPanel.classList.remove('wr-enter');
    void this.overPanel.offsetWidth;
    this.overPanel.classList.add('wr-enter');
    this.countUp(r.score);
  }

  /** Cheap to call every frame: only touches the DOM when a displayed value changed. */
  updateHud(s: SimState): void {
    if (s.score !== this.lastScore) {
      this.lastScore = s.score;
      this.scoreText.data = fmt(s.score);
    }
    if (s.coins !== this.lastCoins) {
      if (this.lastCoins >= 0 && s.coins > this.lastCoins) {
        this.bumpFlip = !this.bumpFlip;
        this.coinPill.classList.remove(this.bumpFlip ? 'wr-bump-b' : 'wr-bump-a');
        this.coinPill.classList.add(this.bumpFlip ? 'wr-bump-a' : 'wr-bump-b');
      }
      this.lastCoins = s.coins;
      this.coinText.data = String(s.coins);
    }
    if (s.multiplier !== this.lastMult) {
      this.lastMult = s.multiplier;
      this.multEl.classList.toggle('wr-on', s.multiplier > 1);
      if (s.multiplier > 1) this.multText.data = `x${s.multiplier}`;
    }
    const p = s.powerups;
    this.setChip(this.chips[0], p.magnet, POWERUP_DURATION.magnet);
    this.setChip(this.chips[1], p.boost, POWERUP_DURATION.boost);
    this.setChip(this.chips[2], p.multiplier, POWERUP_DURATION.multiplier);
    this.setChip(this.chips[3], p.shield, 0);
  }

  /** Zone-name banner (about 2 s). */
  toast(text: string): void {
    if (this.current !== 'hud' && this.current !== 'countdown') return;
    this.toastText.data = text;
    this.toastFlip = !this.toastFlip;
    this.toastEl.classList.remove('wr-show-a', 'wr-show-b');
    this.toastEl.classList.add(this.toastFlip ? 'wr-show-a' : 'wr-show-b');
  }

  /**
   * Short floating popup under the zone-banner slot, e.g. popup('Near miss!', 'great').
   * At most two are visible (fixed slots, never overlapping). Near misses and distance marks
   * are dropped while both slots are busy; other popups wait up to ~1.3 s (or replace a
   * lower-priority one). Ignored unless the HUD is showing.
   */
  popup(text: string, kind: PopupKind = 'good'): void {
    if (this.current !== 'hud' && this.current !== 'countdown') return;
    const prio = popupPriority(text, kind);
    const now = performance.now();
    // same text still visible: just refresh it
    for (let i = 0; i < this.popups.length; i++) {
      if (this.popupText[i] === text && now < this.popupUntil[i]) {
        this.playPopup(i, text, kind, prio, now);
        return;
      }
    }
    let slot = -1;
    for (let i = 0; i < this.popups.length; i++) if (now >= this.popupUntil[i]) { slot = i; break; }
    if (slot < 0) {
      if (prio <= 1) return; // busy: drop near-miss / distance popups
      let low = 0;
      for (let i = 1; i < this.popups.length; i++) if (this.popupPrio[i] < this.popupPrio[low]) low = i;
      if (this.popupPrio[low] < prio) slot = low;
    }
    if (slot >= 0) {
      this.playPopup(slot, text, kind, prio, now);
      return;
    }
    // all slots hold equal/higher priority popups: wait for one to finish
    if (this.popupQueue.length >= POPUP_QUEUE_MAX) this.popupQueue.shift();
    this.popupQueue.push({ text, kind, prio, at: now });
    this.schedulePopupPump(now);
  }

  private playPopup(slot: number, text: string, kind: PopupKind, prio: number, now: number): void {
    const p = this.popups[slot];
    this.popupUntil[slot] = now + POPUP_MS;
    this.popupPrio[slot] = prio;
    this.popupText[slot] = text;
    p.textContent = text;
    p.className = 'wr-popup';
    void p.offsetWidth; // restart the animation
    p.className = `wr-popup wr-go wr-pop-${kind}`;
  }

  private schedulePopupPump(now: number): void {
    window.clearTimeout(this.popupPump);
    let next = Infinity;
    for (const u of this.popupUntil) next = Math.min(next, u);
    this.popupPump = window.setTimeout(() => {
      const t = performance.now();
      this.popupQueue = this.popupQueue.filter((q) => t - q.at < POPUP_QUEUE_TTL);
      const q = this.popupQueue.shift();
      if (q && (this.current === 'hud' || this.current === 'countdown')) this.popup(q.text, q.kind);
      if (this.popupQueue.length) this.schedulePopupPump(performance.now());
    }, Math.max(20, next - now + 10));
  }

  private clearTransient(): void {
    window.clearTimeout(this.popupPump);
    this.popupQueue = [];
    for (let i = 0; i < this.popups.length; i++) {
      this.popups[i].className = 'wr-popup';
      this.popupUntil[i] = 0;
      this.popupText[i] = '';
    }
    this.toastEl.classList.remove('wr-show-a', 'wr-show-b');
  }

  /** Reflect a mute state changed elsewhere (does not call onMute). */
  syncMuted(m: boolean): void {
    this.muted = m;
    this.renderMute();
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /**
   * Stumble danger meter under the score: `fraction` 1 = just stumbled, 0 = safe (hidden).
   * Cheap to call every frame.
   */
  setDanger(fraction: number): void {
    const q = fraction <= 0 ? 0 : Math.max(0.02, Math.round(fraction * 50) / 50);
    if (q === this.lastDanger) return;
    this.lastDanger = q;
    this.dangerEl.classList.toggle('wr-on', q > 0);
    this.dangerBar.style.transform = `scaleX(${q})`;
  }

  /** Start the 3-2-1 resume countdown (no-op if one is already running). */
  beginResume(): void {
    if (this.current === 'pause') this.resumeWithCountdown();
  }

  /** True while the 3-2-1 is running. */
  get isCounting(): boolean {
    return this.counting;
  }

  /** Clear transient feedback (popups, toast, danger meter, countdown): new run / back to menu. */
  reset(): void {
    this.cancelCountdown();
    this.clearTransient();
    this.setDanger(0);
  }

  /** Abort a pending 3-2-1 (the game resumed some other way). */
  cancelCountdown(): void {
    window.clearTimeout(this.countTimer);
    this.counting = false;
  }

  dispose(): void {
    this.cancelCountdown();
    window.removeEventListener('keydown', this.onKey);
    cancelAnimationFrame(this.countRaf);
  }

  // --------------------------------------------------------------- internals

  private makeMuteButton(
    button: (children: (string | Node)[], cls: string, fn: () => void, label?: string) => HTMLButtonElement,
    wide = false,
  ): HTMLButtonElement {
    const b = button([], wide ? 'wr-secondary wr-mute wr-mute-wide' : 'wr-round wr-mute', () => this.toggleMute(), 'Toggle sound');
    this.muteBtns.push(b);
    return b;
  }

  private makeChip(parent: HTMLElement, ic: IconName, cls: string, withBar: boolean): Chip {
    const root = el('div', `wr-chip ${cls}`);
    root.append(icon(ic));
    let bar: HTMLElement | null = null;
    if (withBar) {
      const track = el('div', 'wr-chip-bar');
      bar = el('i', '');
      track.append(bar);
      root.append(track);
    } else {
      root.append(el('span', 'wr-chip-ready', 'READY'));
    }
    parent.append(root);
    return { root, bar, q: -1, low: false };
  }

  private setChip(c: Chip, value: number, duration: number): void {
    if (duration <= 0) {
      // held indicator (shield): 1 = held
      const q = value > 0 ? 1 : 0;
      if (q !== c.q) {
        c.q = q;
        c.root.classList.toggle('wr-on', q === 1);
      }
      return;
    }
    const frac = value > 0 ? Math.min(1, value / duration) : 0;
    const q = value > 0 ? Math.max(1, Math.ceil(frac * CHIP_STEPS)) : 0;
    if (q === c.q) return;
    const wasOn = c.q > 0;
    c.q = q;
    if (q > 0 !== wasOn) c.root.classList.toggle('wr-on', q > 0);
    if (q > 0 && c.bar) c.bar.style.transform = `scaleX(${(q / CHIP_STEPS).toFixed(3)})`;
    const low = q > 0 && q <= CHIP_STEPS * 0.25;
    if (low !== c.low) {
      c.low = low;
      c.root.classList.toggle('wr-low', low);
    }
  }

  private buildHowto(): DocumentFragment {
    const f = document.createDocumentFragment();
    const cap = (t: string, wide = false) => el('kbd', wide ? 'wr-key wr-key-wide' : 'wr-key', t);
    const item = (keys: HTMLElement[], text: string) => {
      const d = el('div', 'wr-how');
      const k = el('span', 'wr-how-keys');
      k.append(...keys);
      d.append(k, el('span', 'wr-how-t', text));
      return d;
    };
    const keys = el('div', 'wr-howto-keys');
    keys.append(
      item([cap('←'), cap('→')], 'Change lane'),
      item([cap('↑'), cap('Space', true)], 'Jump'),
      item([cap('↓')], 'Roll'),
      item([cap('P', false)], 'Pause'),
    );
    const arrow = (dir: 'l' | 'r' | 'u' | 'd') => {
      const s = icon('arrow');
      s.classList.add('wr-sw', `wr-sw-${dir}`);
      return s;
    };
    const touch = el('div', 'wr-howto-touch');
    touch.append(
      item([arrow('l'), arrow('r')], 'Swipe to change lane'),
      item([arrow('u')], 'Swipe up to jump'),
      item([arrow('d')], 'Swipe down to roll'),
    );
    f.append(keys, touch);
    return f;
  }

  private toggleMute(): void {
    this.muted = !this.muted;
    this.renderMute();
    saveSettings({ muted: this.muted });
    this.h.onMute(this.muted);
  }

  private renderMute(): void {
    for (const b of this.muteBtns) {
      b.innerHTML = '';
      b.append(icon(this.muted ? 'soundOff' : 'soundOn'));
      if (b.classList.contains('wr-mute-wide')) b.append(el('span', 'wr-btn-label', this.muted ? 'Sound off' : 'Sound on'));
      b.classList.toggle('wr-off', this.muted);
      b.setAttribute('aria-pressed', String(this.muted));
    }
  }

  private setQuality(q: Quality, notify: boolean): void {
    this.quality = q;
    this.renderQuality();
    if (notify) {
      saveSettings({ quality: q });
      this.h.onQuality(q);
    }
  }

  private renderQuality(): void {
    this.qualityBtns.forEach((b, i) => {
      const on = QUALITIES[i] === this.quality;
      b.classList.toggle('wr-on', on);
      b.setAttribute('aria-checked', String(on));
    });
  }

  private resumeWithCountdown(): void {
    if (this.counting) return;
    if (this.opts.resumeCountdown === false) {
      this.h.onResume();
      return;
    }
    this.counting = true;
    this.show('countdown');
    let n = 3;
    const step = () => {
      if (!this.counting) return;
      if (n === 0) {
        this.counting = false;
        this.h.onResume();
        return;
      }
      this.countNum.textContent = String(n);
      this.countNum.classList.remove('wr-tick');
      void this.countNum.offsetWidth;
      this.countNum.classList.add('wr-tick');
      n--;
      this.countTimer = window.setTimeout(step, 650);
    };
    step();
  }

  private countUp(target: number): void {
    cancelAnimationFrame(this.countRaf);
    if (this.reduceMotion || target <= 0) {
      this.overScoreText.data = fmt(target);
      return;
    }
    const t0 = performance.now();
    const dur = Math.min(1400, 600 + target * 0.12);
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      this.overScoreText.data = fmt(target * e);
      if (k < 1) this.countRaf = requestAnimationFrame(tick);
    };
    this.overScoreText.data = '0';
    this.countRaf = requestAnimationFrame(tick);
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code !== 'Space' && e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'BUTTON' || t.tagName === 'SELECT' || t.tagName === 'INPUT')) return; // native activation
    if (this.current === 'menu') {
      e.preventDefault();
      this.h.onPlay();
    } else if (this.current === 'gameover') {
      e.preventDefault();
      if (performance.now() - this.overShownAt >= GAMEOVER_INPUT_LOCK_MS) this.h.onRestart();
    }
  };

  private show(screen: Screen | null): void {
    if (screen !== 'countdown') this.cancelCountdown();
    if (screen !== 'gameover') cancelAnimationFrame(this.countRaf);
    this.current = screen;
    if (screen !== 'hud' && screen !== 'countdown') this.clearTransient();
    for (const [k, e] of Object.entries(this.screens)) {
      const vis = k === screen || (screen === 'countdown' && k === 'hud');
      e.classList.toggle('wr-visible', vis);
    }
    this.root.dataset.screen = screen ?? '';
  }
}
