import './styles/main.css';
import { Game } from './Game';

function main(): void {
  const canvas = document.getElementById('game') as HTMLCanvasElement | null;
  if (!canvas) {
    console.error('[TANKFORGE] #game canvas missing');
    return;
  }

  const game = new Game(canvas);
  (window as unknown as { __tankforge: Game }).__tankforge = game;

  game.boot().catch((err) => {
    console.error('[TANKFORGE] boot failed', err);
    const boot = document.getElementById('boot-text');
    if (boot) boot.textContent = 'Boot failed — please reload';
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main, { once: true });
} else {
  main();
}
