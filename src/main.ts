import { Game } from './game/Game';

async function boot() {
  let canvas = document.getElementById('game') as HTMLCanvasElement | null;
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'game';
    document.body.appendChild(canvas);
  }
  Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', display: 'block' });

  const hud = document.createElement('div');
  Object.assign(hud.style, {
    position: 'fixed', right: '24px', bottom: '20px', color: '#fff', font: '700 22px Orbitron, monospace',
    textShadow: '0 0 8px #f0f', zIndex: '10', pointerEvents: 'none',
  });
  document.body.appendChild(hud);
  const help = document.createElement('div');
  Object.assign(help.style, {
    position: 'fixed', left: '20px', top: '16px', color: '#cfe', font: '600 14px "Chakra Petch", monospace',
    textShadow: '0 0 6px #000', zIndex: '10', pointerEvents: 'none', whiteSpace: 'pre', opacity: '0.85',
  });
  help.textContent = 'YWGI DRIVE — physics preview\nW/S throttle/brake · A/D steer · SPACE handbrake · SHIFT nitro\nC camera · R reset · Q/E manual shift · B look back';
  document.body.appendChild(help);

  const game = new Game(canvas);
  game.hud = hud;
  await game.init((p, t) => (hud.textContent = `${t}… ${(p * 100) | 0}%`));
  game.start();
  (window as unknown as { game: Game }).game = game;
}

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#f66;position:fixed;top:40%;left:20px;z-index:99">${String(e?.stack ?? e)}</pre>`);
});
