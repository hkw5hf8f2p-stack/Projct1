(() => {
  const de = document.documentElement;
  const sig = [Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0), Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0)];
  for (const el of Array.from(document.querySelectorAll("h1,h2,a[href],button,img,input,section,footer,header")).slice(0, 200)) {
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 1) continue;
    sig.push(Math.round(r.left * 10) / 10, Math.round(r.top * 10) / 10, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10);
  }
  return sig;
})()
