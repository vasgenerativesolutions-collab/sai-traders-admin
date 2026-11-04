const fs = require('fs');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');
const path = require('path');

const srcPath = 'C:/Users/mithu/.gemini/antigravity-ide/brain/ccf6e5bf-3e1e-479f-88fa-052d73ed4c51/.user_uploaded/media_1790675665704.jpg';
const raw = fs.readFileSync(srcPath);
const img = jpeg.decode(raw, { useTArray: true });
const { width, height, data } = img;

console.log('Decoded image:', width, 'x', height);

// Check corners to estimate background
const cornerSamples = [];
for (let y = 0; y < 30; y++) {
  for (let x = 0; x < 30; x++) {
    const idx = (y * width + x) * 4;
    cornerSamples.push([data[idx], data[idx + 1], data[idx + 2]]);
  }
}
let avgR = 0, avgG = 0, avgB = 0;
for (const [r, g, b] of cornerSamples) {
  avgR += r;
  avgG += g;
  avgB += b;
}
avgR = Math.round(avgR / cornerSamples.length);
avgG = Math.round(avgG / cornerSamples.length);
avgB = Math.round(avgB / cornerSamples.length);
console.log('Average background color:', avgR, avgG, avgB);

// Find bounding box of foreground elements
// A pixel is foreground if it deviates significantly from the off-white background
let minX = width, maxX = 0, minY = height, maxY = 0;
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const idx = (y * width + x) * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    const diff = Math.sqrt((r - avgR) ** 2 + (g - avgG) ** 2 + (b - avgB) ** 2);
    if (diff > 25) { // Foreground pixel
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}

console.log('Bounding box:', { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY });

// Add padding of 15px
const pad = 15;
const cropX = Math.max(0, minX - pad);
const cropY = Math.max(0, minY - pad);
const cropW = Math.min(width - cropX, (maxX - minX) + pad * 2);
const cropH = Math.min(height - cropY, (maxY - minY) + pad * 2);

console.log('Cropped box:', { cropX, cropY, cropW, cropH });

// 1. Create transparent PNG
const pngTrans = new PNG({ width: cropW, height: cropH });
// 2. Create pure white background PNG
const pngWhite = new PNG({ width: cropW, height: cropH });

for (let y = 0; y < cropH; y++) {
  for (let x = 0; x < cropW; x++) {
    const srcIdx = ((cropY + y) * width + (cropX + x)) * 4;
    const dstIdx = (y * cropW + x) * 4;

    const r = data[srcIdx];
    const g = data[srcIdx + 1];
    const b = data[srcIdx + 2];

    const diff = Math.sqrt((r - avgR) ** 2 + (g - avgG) ** 2 + (b - avgB) ** 2);

    if (diff <= 18) {
      // Complete background -> transparent in pngTrans, pure white in pngWhite
      pngTrans.data[dstIdx] = 255;
      pngTrans.data[dstIdx + 1] = 255;
      pngTrans.data[dstIdx + 2] = 255;
      pngTrans.data[dstIdx + 3] = 0;

      pngWhite.data[dstIdx] = 255;
      pngWhite.data[dstIdx + 1] = 255;
      pngWhite.data[dstIdx + 2] = 255;
      pngWhite.data[dstIdx + 3] = 255;
    } else if (diff <= 38) {
      // Soft edge antialiasing
      const alpha = Math.min(255, Math.max(0, Math.round(((diff - 18) / 20) * 255)));
      pngTrans.data[dstIdx] = r;
      pngTrans.data[dstIdx + 1] = g;
      pngTrans.data[dstIdx + 2] = b;
      pngTrans.data[dstIdx + 3] = alpha;

      // In white background version, blend towards pure white
      const t = alpha / 255;
      pngWhite.data[dstIdx] = Math.round(r * t + 255 * (1 - t));
      pngWhite.data[dstIdx + 1] = Math.round(g * t + 255 * (1 - t));
      pngWhite.data[dstIdx + 2] = Math.round(b * t + 255 * (1 - t));
      pngWhite.data[dstIdx + 3] = 255;
    } else {
      // Foreground pixel
      pngTrans.data[dstIdx] = r;
      pngTrans.data[dstIdx + 1] = g;
      pngTrans.data[dstIdx + 2] = b;
      pngTrans.data[dstIdx + 3] = 255;

      pngWhite.data[dstIdx] = r;
      pngWhite.data[dstIdx + 1] = g;
      pngWhite.data[dstIdx + 2] = b;
      pngWhite.data[dstIdx + 3] = 255;
    }
  }
}

// Write PNGs
const outTransPath = 'c:/sai_traders/assets/kalpacodes_logo_transparent.png';
const outWhitePath = 'c:/sai_traders/assets/kalpacodes_logo.png';

fs.writeFileSync(outTransPath, PNG.sync.write(pngTrans));
fs.writeFileSync(outWhitePath, PNG.sync.write(pngWhite));

console.log('Successfully saved:');
console.log('Transparent:', outTransPath, 'size:', fs.statSync(outTransPath).size);
console.log('White background:', outWhitePath, 'size:', fs.statSync(outWhitePath).size);
