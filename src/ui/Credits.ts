/** Corner "Credits" button + overlay listing asset attributions (CC-BY requires visible credit). */
export class Credits {
  private btn: HTMLButtonElement;
  private panel: HTMLDivElement;
  private lines: string[] = [];

  constructor(root: HTMLElement) {
    const style = document.createElement('style');
    style.textContent = `
      .ywgi-credits-btn{position:fixed;right:18px;bottom:14px;z-index:60;font:600 11px "Barlow",sans-serif;letter-spacing:.24em;
        color:rgba(244,242,238,.7);background:rgba(14,15,17,.55);border:1px solid rgba(255,255,255,.18);padding:7px 12px 6px;cursor:pointer;
        backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);transition:color .15s,border-color .15s}
      .ywgi-credits-btn:hover{color:#fff;border-color:rgba(255,255,255,.5)}
      .ywgi-credits{position:fixed;inset:7vh 7vw;z-index:70;display:none;flex-direction:column;background:rgba(11,12,14,.95);
        border:1px solid rgba(255,255,255,.14);color:rgba(244,242,238,.82);font:400 14px/1.6 "Barlow",sans-serif}
      .ywgi-credits header{display:flex;justify-content:space-between;align-items:center;padding:18px 22px;border-bottom:1px solid rgba(255,255,255,.12)}
      .ywgi-credits h2{margin:0;font:600 28px "Barlow Condensed",sans-serif;letter-spacing:.04em;color:#f4f2ee;display:flex;align-items:center;gap:12px}
      .ywgi-credits h2::before{content:"";width:18px;height:2px;background:#ffb400}
      .ywgi-credits button{font:600 11px "Barlow",sans-serif;letter-spacing:.22em;color:#1a1305;background:#ffb400;border:0;padding:9px 14px 8px;cursor:pointer}
      .ywgi-credits .body{overflow:auto;padding:16px 22px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.2) transparent}
      .ywgi-credits .body p{margin:0;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.07)}
      .ywgi-credits .body p:first-child{color:rgba(244,242,238,.6);font-size:13px}
      .ywgi-credits .body a{color:#f4f2ee;text-decoration:none;border-bottom:1px solid #ffb400}
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
