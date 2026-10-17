/** Corner "Credits" button + overlay listing asset attributions (CC-BY requires visible credit). */
export class Credits {
  private btn: HTMLButtonElement;
  private panel: HTMLDivElement;
  private lines: string[] = [];

  constructor(root: HTMLElement) {
    const style = document.createElement('style');
    style.textContent = `
      .ywgi-credits-btn{position:fixed;right:18px;bottom:14px;z-index:60;font:600 12px "Chakra Petch",sans-serif;letter-spacing:.14em;
        color:#cfd6ff;background:rgba(10,8,24,.55);border:1px solid rgba(124,248,255,.35);padding:7px 12px;cursor:pointer;
        transform:skewX(-10deg);backdrop-filter:blur(6px)}
      .ywgi-credits-btn:hover{color:#fff;border-color:#ff2bd6}
      .ywgi-credits{position:fixed;inset:6vh 6vw;z-index:70;display:none;flex-direction:column;background:rgba(8,6,20,.92);
        border:1px solid rgba(255,43,214,.45);box-shadow:0 0 40px rgba(255,43,214,.25);color:#e8ecff;font:500 13px/1.5 "Chakra Petch",sans-serif}
      .ywgi-credits header{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.08)}
      .ywgi-credits h2{margin:0;font:800 20px Orbitron,sans-serif;letter-spacing:.08em}
      .ywgi-credits button{font:600 12px "Chakra Petch";letter-spacing:.12em;color:#fff;background:#ff2bd6;border:0;padding:8px 14px;cursor:pointer}
      .ywgi-credits .body{overflow:auto;padding:14px 18px}
      .ywgi-credits .body p{margin:0 0 8px}
      .ywgi-credits .body a{color:#7cf8ff}
    `;
    document.head.appendChild(style);
    this.btn = document.createElement('button');
    this.btn.className = 'ywgi-credits-btn';
    this.btn.textContent = 'CREDITS';
    this.btn.addEventListener('click', () => this.open());
    this.panel = document.createElement('div');
    this.panel.className = 'ywgi-credits';
    this.panel.innerHTML = `<header><h2>CREDITS</h2><button>CLOSE</button></header><div class="body"></div>`;
    this.panel.querySelector('button')!.addEventListener('click', () => this.close());
    window.addEventListener('keydown', (e) => {
      if (this.isOpen && (e.code === 'Escape' || e.code === 'Enter')) {
        e.stopImmediatePropagation();
        this.close();
      }
    }, true);
    root.appendChild(this.btn);
    root.appendChild(this.panel);
  }

  get isOpen(): boolean {
    return this.panel.style.display === 'flex';
  }

  setLines(lines: string[]) {
    this.lines = lines;
  }

  showButton(on: boolean) {
    this.btn.style.display = on ? 'block' : 'none';
    if (!on) this.close();
  }

  open() {
    const body = this.panel.querySelector('.body')!;
    body.innerHTML = '';
    const intro = document.createElement('p');
    intro.textContent =
      'YWGI DRIVE — Midnight Circuit. Built with three.js, Rapier and pmndrs postprocessing. Vehicle models are fan-made 3D artworks used under their Creative Commons licenses; car makers’ names and logos are trademarks of their owners and are not used. Full license files ship with the game under /assets/*/CREDITS*.md.';
    body.appendChild(intro);
    for (const l of this.lines) {
      const p = document.createElement('p');
      p.textContent = l;
      body.appendChild(p);
    }
    for (const [label, href] of [
      ['Car model credits', 'assets/cars/CREDITS-sports.md'],
      ['Traffic model credits', 'assets/cars/CREDITS-traffic.md'],
      ['Audio credits', 'assets/audio/CREDITS.md'],
      ['Environment credits', 'assets/env/CREDITS.md'],
    ]) {
      const p = document.createElement('p');
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = label;
      p.appendChild(a);
      body.appendChild(p);
    }
    this.panel.style.display = 'flex';
  }

  close() {
    this.panel.style.display = 'none';
  }
}
