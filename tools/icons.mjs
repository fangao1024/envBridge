import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
export function crc32(data) {
  let crc = 0xffffffff;
  for (const value of data) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const type = Buffer.from(name); const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); type.copy(result, 4); data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([type, data])), result.length - 4); return result;
}
function segmentDistance(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy)));
  return Math.hypot(x-a[0]-t*dx,y-a[1]-t*dy);
}
const segments = [[[15,40],[15,25]],[[15,25],[21,19]],[[21,19],[28,19]],[[49,24],[49,39]],[[49,39],[43,45]],[[43,45],[36,45]]];
export async function makeIcons() {
  await mkdir('assets', { recursive: true });
  for (const size of [16,32,48,128]) {
    const rows = Buffer.alloc((size*4+1)*size);
    for(let y=0;y<size;y++)for(let x=0;x<size;x++) {
      const sums=[0,0,0,0];
      for(let sy=0;sy<4;sy++)for(let sx=0;sx<4;sx++) {
        const px=(x+(sx+.5)/4)/size*64,py=(y+(sy+.5)/4)/size*64;
        const cornerX=Math.max(18,Math.min(46,px)),cornerY=Math.max(18,Math.min(46,py));
        const inside=Math.hypot(px-cornerX,py-cornerY)<=18;
        let color=inside?[33,103,80,255]:[0,0,0,0];
        if(inside&&segments.some(([a,b])=>segmentDistance(px,py,a,b)<2.5))color=[228,242,189,255];
        if(inside&&[[[24,32],[41,32]],[[35,26],[41,32]],[[41,32],[35,38]]].some(([a,b])=>segmentDistance(px,py,a,b)<2))color=[255,255,255,255];
        color.forEach((value,i)=>sums[i]+=value);
      }
      sums.forEach((value,i)=>rows[y*(size*4+1)+1+x*4+i]=Math.round(value/16));
    }
    const header=Buffer.alloc(13);header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
    const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
    await writeFile(`assets/icon-${size}.png`,png);
  }
}
if (process.argv[1]?.endsWith('icons.mjs')) { await makeIcons(); console.log('Generated 16/32/48/128px extension icons.'); }
