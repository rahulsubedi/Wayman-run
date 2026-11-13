import { installDebugHook, readParams } from './debug';
import { Game } from './game';

const debug = installDebugHook();
const params = readParams();

async function boot(): Promise<void> {
  const gameRoot = document.getElementById('game')!;
  const uiRoot = document.getElementById('ui')!;
  const game = await Game.create(gameRoot, uiRoot, {
    seed: params.seed,
    quality: params.quality,
    muted: params.mute,
    forceZone: params.zone,
    preference: params.renderer,
  });
  debug.attach(game, params);
}

boot().catch((err) => {
  console.error(err);
  debug.fail(err);
  const msg = document.createElement('pre');
  msg.style.cssText = 'position:fixed;inset:0;margin:0;padding:24px;color:#fff;background:#1b2a3a;white-space:pre-wrap;font:14px monospace';
  msg.textContent = `Wayman Run could not start.\n\n${String((err as Error)?.message ?? err)}`;
  document.body.append(msg);
});
