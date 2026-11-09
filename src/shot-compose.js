// Joins the pictures of the camera button into one PNG: a title line, then per pane a label bar (NEW SERVER or LIVE, IP,
// how it was reached, reverse DNS) above the page. Runs in the window UI because a canvas needs a page; the main process
// calls window.composeShot(spec) and saves or copies the result. Drawn at the scale of the captures (2x on Retina).
'use strict';
(() => {
  const PAD = 12, GAP = 12, TOP = 46, BAR = 44;
  const C = { tint: '#f2f6fb', card: '#ffffff', line: '#dbe5f2', ink: '#0e1726', ink2: '#4c6384', ink3: '#7b90af',
    blue: '#2e90fa', blueInk: '#175cd3', blueSoft: '#e8f1fd', green: '#12b76a', greenInk: '#027a48', greenSoft: '#e6f7ef' };
  const load = data => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('A capture could not be read.')); image.src = `data:image/png;base64,${data}`; });
  function text(g, value, x, y, font, color, align = 'left') { g.font = font; g.fillStyle = color; g.textAlign = align; g.fillText(value, x, y); return g.measureText(value).width; }
  function labelBar(g, pane, x, y, width) {
    const live = pane.live;
    g.fillStyle = C.card; g.fillRect(x, y, width, BAR);
    g.fillStyle = live ? C.green : C.blue; g.fillRect(x, y, width, 3);
    const badge = live ? 'LIVE' : 'NEW SERVER'; g.font = '700 11px "JetBrains Mono"'; const bw = g.measureText(badge).width + 16;
    g.fillStyle = live ? C.greenSoft : C.blueSoft; g.beginPath(); g.roundRect(x + 12, y + 12, bw, 22, 5); g.fill();
    text(g, badge, x + 20, y + 24, '700 11px "JetBrains Mono"', live ? C.greenInk : C.blueInk);
    let at = x + 24 + bw;
    at += text(g, pane.ip || 'IP not measured', at, y + 24, '700 14px "JetBrains Mono"', C.ink) + 10;
    at += text(g, pane.via, at, y + 24, '600 12px "Plus Jakarta Sans"', C.ink2) + 10;
    if (pane.ptr && at < x + width - 40) text(g, pane.ptr, at, y + 24, '500 12px "JetBrains Mono"', C.ink3);
  }
  window.composeShot = async spec => {
    await Promise.all(['700 15px "Plus Jakarta Sans"', '600 12px "Plus Jakarta Sans"', '700 14px "JetBrains Mono"', '500 12px "JetBrains Mono"'].map(f => document.fonts.load(f)));
    const panes = await Promise.all(spec.panes.map(async p => ({ ...p, images: await Promise.all(p.tiles.map(t => load(t.data))) })));
    // The scale of the captures: device pixels per CSS pixel, so text and page stay sharp together.
    const scale = Math.max(1, ...panes.map(p => p.images[0].naturalWidth / p.width));
    const width = PAD * 2 + panes.reduce((sum, p) => sum + p.width, 0) + GAP * (panes.length - 1), tallest = Math.max(...panes.map(p => p.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.ceil(width * scale); canvas.height = Math.ceil((TOP + BAR + tallest + PAD) * scale);
    const g = canvas.width <= 32767 && canvas.height <= 32767 ? canvas.getContext('2d') : null;
    if (!g) throw new Error('The picture is too large to make. Try Visible area or one pane.');
    g.scale(scale, scale); g.textBaseline = 'middle';
    g.fillStyle = C.tint; g.fillRect(0, 0, width, TOP + BAR + tallest + PAD);
    const host = text(g, spec.host, PAD + 2, TOP / 2, '700 15px "Plus Jakarta Sans"', C.ink);
    text(g, spec.url.length > 120 ? `${spec.url.slice(0, 119)}…` : spec.url, PAD + 14 + host, TOP / 2, '500 12px "JetBrains Mono"', C.ink3);
    text(g, `${spec.when}  ·  Dioptra ${spec.version}`, width - PAD - 2, TOP / 2, '500 12px "JetBrains Mono"', C.ink3, 'right');
    let x = PAD;
    for (const p of panes) {
      labelBar(g, p, x, TOP, p.width);
      p.tiles.forEach((t, i) => g.drawImage(p.images[i], x, TOP + BAR + t.y, p.width, t.h));
      g.strokeStyle = C.line; g.lineWidth = 1; g.strokeRect(x + 0.5, TOP + 0.5, p.width - 1, BAR + p.height - 1);
      const note = p.cut ? 'Cut off here: the page is longer than one image can hold' : p.height < tallest ? 'End of page' : '';
      if (note) text(g, note, x + p.width / 2, TOP + BAR + p.height + 18, '600 12px "Plus Jakarta Sans"', C.ink3, 'center');
      x += p.width + GAP;
    }
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('The picture is too large to save.');
    const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { png: btoa(binary), width: canvas.width, height: canvas.height };
  };
})();
