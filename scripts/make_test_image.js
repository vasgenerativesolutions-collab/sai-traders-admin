/**
 * A real PNG, big enough for a vision model to accept.
 *
 *   node scripts/make_test_image.js            print it as base64
 *   node scripts/make_test_image.js out.png    write the file
 *
 * Tests that exercise Gemini vision need an actual picture. An 8x8 image is refused
 * with "Unable to process input image", which looks exactly like a broken code path —
 * I chased that for a while. This writes a 96x96 image with some structure in it, built
 * from zlib alone so nothing has to be installed.
 */
'use strict';

const zlib = require('zlib');
const fs = require('fs');

const SIZE = 96;

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// Rows of RGB with a filter byte each. Bands and a border, so the image has features
// rather than being one flat colour a model may decline to describe.
const raw = [];
for (let y = 0; y < SIZE; y++) {
  raw.push(0); // filter: none
  for (let x = 0; x < SIZE; x++) {
    const edge = x < 6 || y < 6 || x > SIZE - 7 || y > SIZE - 7;
    const band = Math.floor(y / 12) % 2 === 0;
    if (edge) raw.push(201, 162, 39);              // a gold border
    else if (band) raw.push(18, 92, 58);           // deep green
    else raw.push(86, 28, 112);                    // purple
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 2;   // colour type: truecolour
ihdr[10] = 0;  // deflate
ihdr[11] = 0;  // adaptive filtering
ihdr[12] = 0;  // no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(Buffer.from(raw), { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

// Only when run directly. Required as a module it must print nothing, or it writes
// a wall of base64 into the output of whatever imported it.
const out = require.main === module ? process.argv[2] : null;
if (require.main === module) {
if (out) {
  fs.writeFileSync(out, png);
  console.log(`wrote ${out} — ${SIZE}x${SIZE}, ${png.length} bytes`);
} else {
  process.stdout.write(png.toString('base64'));
}

}

module.exports = { pngBase64: () => png.toString('base64'), mimeType: 'image/png' };
