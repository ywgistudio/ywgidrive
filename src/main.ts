import { RaceGame } from './game/RaceGame';

async function boot() {
  let canvas = document.getElementById('game') as HTMLCanvasElement | null;
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'game';
    document.body.appendChild(canvas);
  }
  let ui = document.getElementById('ui');
  if (!ui) {
    ui = document.createElement('div');
    ui.id = 'ui';
    document.body.appendChild(ui);
  }
  const game = new RaceGame(canvas, ui);
  (window as unknown as { game: RaceGame }).game = game;
  await game.init();
  game.start();
}

boot().catch((e) => {
  console.error(e);
  const pre = document.createElement('pre');
  pre.style.cssText = 'color:#f66;position:fixed;top:30%;left:20px;right:20px;z-index:999;white-space:pre-wrap;font:12px monospace;background:#000c;padding:12px';
  pre.textContent = 'Something went wrong starting the game:\n' + String(e?.stack ?? e);
  document.body.appendChild(pre);
});
